// Unit tests for server/lib/discovery.js
// dgram and net are mocked, so no real sockets are opened. The SSDP test feeds a realistic
// captured beacon payload; the scan test drives a fake TCP probe. Covers parsing, the
// already-known dedup, the time box, and the never-throws contract.

jest.mock('dgram');
jest.mock('net');

const dgram = require('dgram');
const net = require('net');
const discovery = require('../lib/discovery');

// A realistic Bambu LAN-mode SSDP announcement beacon (HTTP-over-UDP header lines). Field
// names mirror the widely-reported layout; the parser treats them all as optional.
const BAMBU_BEACON = Buffer.from([
  'NOTIFY * HTTP/1.1',
  'HOST: 239.255.255.250:2021',
  'Server: Bambu Lab/1.0 UPnP/1.0',
  'Location: 192.168.1.42',
  'NT: urn:bambulab-com:device:3dprinter:1',
  'USN: 00M09C1234567890',
  'Cache-Control: max-age=1800',
  'DevModel.bambu.com: C11',
  'DevName.bambu.com: My X1C',
  'DevSignal.bambu.com: -44',
  'DevConnect.bambu.com: lan',
  'DevBind.bambu.com: free',
  '',
  '',
].join('\r\n'));

// A generic non-Bambu UPnP beacon that must be ignored.
const NON_BAMBU_BEACON = Buffer.from([
  'NOTIFY * HTTP/1.1',
  'HOST: 239.255.255.250:1900',
  'Server: SomeSmartTV/2.0 UPnP/1.0',
  'NT: urn:schemas-upnp-org:device:MediaRenderer:1',
  'USN: uuid:abcd-1234',
  '',
].join('\r\n'));

// ── SSDP mock socket ────────────────────────────────────────────────────────────

// Build a fake dgram socket that delivers a queued list of [payload, rinfo] pairs to the
// 'message' handler when bind()'s callback runs.
function mockSsdpSocket(deliveries) {
  const handlers = {};
  return {
    on: jest.fn((ev, cb) => { handlers[ev] = cb; }),
    bind: jest.fn((port, cb) => {
      if (cb) cb();
      for (const [payload, rinfo] of deliveries) {
        if (handlers.message) handlers.message(payload, rinfo);
      }
    }),
    addMembership: jest.fn(),
    close: jest.fn(),
  };
}

afterEach(() => jest.clearAllMocks());

// ── parseSsdpPacket ───────────────────────────────────────────────────────────────

describe('parseSsdpPacket', () => {
  test('extracts identity from a Bambu beacon, IP from the datagram source', () => {
    const rec = discovery.parseSsdpPacket(BAMBU_BEACON, { address: '192.168.1.42', port: 2021 });
    expect(rec).toEqual({
      name: 'My X1C',
      model: 'C11',
      serial: '00M09C1234567890',
      ip: '192.168.1.42',
      source: 'ssdp',
    });
  });

  test('ignores a non-Bambu UPnP beacon', () => {
    expect(discovery.parseSsdpPacket(NON_BAMBU_BEACON, { address: '10.0.0.9' })).toBeNull();
  });

  test('tolerates missing identity headers (only IP survives, rest null)', () => {
    const bare = Buffer.from('NOTIFY * HTTP/1.1\r\nServer: Bambu Lab/1.0\r\n\r\n');
    const rec = discovery.parseSsdpPacket(bare, { address: '192.168.1.77' });
    expect(rec).toEqual({ name: null, model: null, serial: null, ip: '192.168.1.77', source: 'ssdp' });
  });

  test('strips a uuid: prefix from a USN-derived serial', () => {
    const p = Buffer.from('NOTIFY * HTTP/1.1\r\nServer: bambu\r\nUSN: uuid:00M09XYZ\r\n\r\n');
    expect(discovery.parseSsdpPacket(p, { address: '1.2.3.4' }).serial).toBe('00M09XYZ');
  });

  test('never throws on garbage input', () => {
    expect(() => discovery.parseSsdpPacket(null, null)).not.toThrow();
    expect(discovery.parseSsdpPacket(Buffer.from('bambu'), null)).toBeNull(); // no ip, no serial
  });
});

// ── discoverSSDP ────────────────────────────────────────────────────────────────

describe('discoverSSDP', () => {
  test('returns parsed Bambu records and drops noise', async () => {
    dgram.createSocket.mockReturnValue(mockSsdpSocket([
      [BAMBU_BEACON, { address: '192.168.1.42', port: 2021 }],
      [NON_BAMBU_BEACON, { address: '10.0.0.9', port: 1900 }],
    ]));

    const recs = await discovery.discoverSSDP({ timeoutMs: 40 });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ ip: '192.168.1.42', serial: '00M09C1234567890', source: 'ssdp' });
  });

  test('dedupes repeat announcements from the same printer', async () => {
    dgram.createSocket.mockReturnValue(mockSsdpSocket([
      [BAMBU_BEACON, { address: '192.168.1.42', port: 2021 }],
      [BAMBU_BEACON, { address: '192.168.1.42', port: 2021 }],
    ]));

    const recs = await discovery.discoverSSDP({ timeoutMs: 40 });
    expect(recs).toHaveLength(1);
  });

  test('resolves [] after the time box when nothing announces, and closes the socket', async () => {
    const sock = mockSsdpSocket([]);
    dgram.createSocket.mockReturnValue(sock);

    const start = Date.now();
    const recs = await discovery.discoverSSDP({ timeoutMs: 30 });
    expect(recs).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(sock.close).toHaveBeenCalled();
  });

  test('never throws when the socket cannot be created', async () => {
    dgram.createSocket.mockImplementation(() => { throw new Error('EADDRINUSE'); });
    await expect(discovery.discoverSSDP({ timeoutMs: 20 })).resolves.toEqual([]);
  });

  test('never throws when the socket emits an error', async () => {
    const handlers = {};
    dgram.createSocket.mockReturnValue({
      on: jest.fn((ev, cb) => { handlers[ev] = cb; }),
      bind: jest.fn(() => { if (handlers.error) handlers.error(new Error('boom')); }),
      addMembership: jest.fn(),
      close: jest.fn(),
    });
    await expect(discovery.discoverSSDP({ timeoutMs: 200 })).resolves.toEqual([]);
  });
});

// ── parseSubnet ─────────────────────────────────────────────────────────────────

describe('parseSubnet', () => {
  test('expands an a.b.c.0/24 to 254 hosts', () => {
    const hosts = discovery.parseSubnet('192.168.1.0/24');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts[253]).toBe('192.168.1.254');
  });

  test('treats a bare a.b.c prefix as a /24', () => {
    expect(discovery.parseSubnet('10.0.5')).toHaveLength(254);
    expect(discovery.parseSubnet('10.0.5')[0]).toBe('10.0.5.1');
  });

  test('rejects a non-/24 CIDR, junk, and out-of-range octets', () => {
    expect(discovery.parseSubnet('192.168.1.0/16')).toBeNull();
    expect(discovery.parseSubnet('not-an-ip')).toBeNull();
    expect(discovery.parseSubnet('999.1.1.0/24')).toBeNull();
    expect(discovery.parseSubnet('')).toBeNull();
    expect(discovery.parseSubnet(null)).toBeNull();
  });
});

// ── discoverScan mock socket ──────────────────────────────────────────────────────

// Hosts/ports the fake TCP layer treats as open. Set per test.
let OPEN_HOSTS = new Set();
let OPEN_PORTS = new Set();

function makeNetSocket() {
  const listeners = {};
  return {
    once: jest.fn((ev, cb) => { listeners[ev] = cb; }),
    setTimeout: jest.fn(),
    destroy: jest.fn(),
    connect: jest.fn((port, ip) => {
      process.nextTick(() => {
        if (OPEN_HOSTS.has(ip) && OPEN_PORTS.has(port)) {
          if (listeners.connect) listeners.connect();
        } else if (listeners.error) {
          listeners.error(new Error('ECONNREFUSED'));
        }
      });
    }),
  };
}

describe('discoverScan', () => {
  beforeEach(() => {
    OPEN_HOSTS = new Set();
    OPEN_PORTS = new Set();
    net.Socket.mockImplementation(() => makeNetSocket());
  });

  test('finds a host answering on a Bambu LAN port; record is address-only', async () => {
    OPEN_HOSTS = new Set(['192.168.1.42']);
    OPEN_PORTS = new Set([8883]);

    const recs = await discovery.discoverScan({ subnet: '192.168.1.0/24', connectTimeoutMs: 20, timeoutMs: 2000 });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toEqual({ name: null, model: null, serial: null, ip: '192.168.1.42', source: 'scan' });
  });

  test('returns [] when no host answers on any probe port', async () => {
    OPEN_HOSTS = new Set(['192.168.1.42']);
    OPEN_PORTS = new Set([1234]); // not a probed port
    const recs = await discovery.discoverScan({ subnet: '192.168.1.0/24', connectTimeoutMs: 20, timeoutMs: 2000 });
    expect(recs).toEqual([]);
  });

  test('returns [] for an invalid subnet without throwing', async () => {
    await expect(discovery.discoverScan({ subnet: 'garbage' })).resolves.toEqual([]);
    await expect(discovery.discoverScan({})).resolves.toEqual([]);
  });
});
