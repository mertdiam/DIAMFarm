// Printer network discovery (TASK 7).
//
// Two strategies, both time-boxed and neither ever throwing:
//   1. discoverSSDP  - passive UDP listen for LAN-mode announcement beacons (same L2 segment).
//   2. discoverScan  - explicit IP-range TCP probe of the Bambu LAN service ports
//                      (works across a routed VLAN where multicast does not reach).
//
// Both return deduped identity+address records: { name, model, serial, ip, source }.
// Discovery yields identity plus address ONLY. It never obtains or guesses an access code:
// the access code is the LAN secret and is filled in later by an operator on the printer's
// detail page. Records are added to the fleet as drafts (empty api_key) by the caller.
//
// Launch scope is Bambu discovery. The module is factored so another brand's beacon parser
// or probe-port set can be added later without reworking the socket/timeout plumbing.
//
// ---------------------------------------------------------------------------------------
// PROTOCOL VERIFICATION (CLAUDE.md non-negotiable 4), checked against
// github.com/Doridian/OpenBambuAPI on 2026-07-12:
//
//   CONFIRMED - LAN service ports used by discoverScan to fingerprint a host:
//     - MQTT over TLS on 8883:  "mqtt://{PRINTER_IP}:8883"   (OpenBambuAPI mqtt.md line 22)
//     - FTP over TLS  on 990:   "ftps://{DEVICE_IP}:990"     (OpenBambuAPI ftp.md line 3)
//
//   NOT DOCUMENTED - the SSDP announcement beacon. OpenBambuAPI has no ssdp/discovery file
//   and no description of the multicast group, UDP port, or beacon header field names.
//   Per the "do not guess a protocol field" rule, the SSDP path is implemented DEFENSIVELY:
//     - The multicast group 239.255.255.250 is the IANA/UPnP standard SSDP address, an
//       internet standard, not a Bambu-specific value.
//     - The listen port below is the value Bambu LAN devices are widely reported to use, but
//       it is NOT confirmed in OpenBambuAPI. It is a named, overridable constant and MUST be
//       validated on real hardware before the SSDP path is trusted.
//     - The beacon is parsed as generic SSDP (HTTP-over-UDP header lines). Every identity
//       header is treated as OPTIONAL: a missing field yields null, never a throw. The host
//       IP is taken from the UDP datagram source address, which does not depend on any
//       header being present. No rigid Bambu beacon layout is assumed or required.
//   Status: SSDP path implemented from standards plus defensive parsing, NOT yet validated
//   on hardware. The IP-scan path uses only OpenBambuAPI-confirmed ports.
// ---------------------------------------------------------------------------------------

const dgram = require('dgram');
const net   = require('net');

// Standard SSDP/UPnP multicast group (internet standard, not Bambu-specific).
const SSDP_MULTICAST_ADDR = '239.255.255.250';
// Bambu LAN beacon port: reported value, NOT confirmed in OpenBambuAPI. Overridable and
// flagged as needs-hardware-validation (see the protocol note above).
const SSDP_PORT = 2021;
// Bambu LAN service ports, both confirmed in OpenBambuAPI (see the protocol note above).
const BAMBU_LAN_PORTS = [8883, 990];

const DEFAULT_TIMEOUT_MS = 4000;      // whole-scan time box (must stay short: this runs on an operator click)
const DEFAULT_PROBE_MS   = 800;       // per-host TCP connect timeout during an IP scan
const SCAN_BATCH         = 32;        // hosts probed concurrently (bounds open socket count)

// Parse one raw SSDP datagram into an identity record, or null if it is not a Bambu beacon.
//
// Defensive by design (the exact beacon layout is unconfirmed, see the protocol note):
//   - Filters to Bambu devices by the vendor signature appearing anywhere in the packet,
//     rather than by requiring a specific header to be present.
//   - Extracts each identity field from a list of candidate header keys; any that are
//     absent become null. The IP comes from the datagram source (rinfo), so a record is
//     produced even when every header is missing.
function parseSsdpPacket(msg, rinfo) {
  const text = msg == null ? '' : msg.toString('utf8');
  // Only Bambu beacons become printer records. A generic UPnP device (smart TV, router)
  // that happens to reach this socket is dropped.
  if (!/bambu/i.test(text)) return null;

  const headers = {};
  for (const line of text.split(/\r\n|\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && !(key in headers)) headers[key] = val;
  }

  const pick = (...keys) => {
    for (const k of keys) {
      const v = headers[k.toLowerCase()];
      if (v != null && v !== '') return v;
    }
    return null;
  };

  let ip = (rinfo && rinfo.address) || null;
  if (!ip) {
    // Fallback: pull an IPv4 out of a Location URL if the datagram source was unavailable.
    const loc = pick('location');
    const m = loc && loc.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (m) ip = m[1];
  }

  const name  = pick('devname.bambu.com', 'devname', 'friendlyname');
  const model = pick('devmodel.bambu.com', 'devmodel');
  let serial  = pick('devserial.bambu.com', 'devserial', 'usn');
  // Standard SSDP USN values are sometimes prefixed "uuid:"; strip it so the serial is clean.
  if (serial) serial = String(serial).replace(/^uuid:/i, '').trim() || null;

  if (!ip && !serial) return null; // nothing identifiable

  return {
    name:   name || null,
    model:  model || null,
    serial: serial || null,
    ip:     ip || null,
    source: 'ssdp',
  };
}

// Dedupe records by serial (the stable identity) when present, else by IP.
function dedupe(records) {
  const seen = new Map();
  for (const r of records) {
    if (!r) continue;
    const key = (r.serial && String(r.serial)) || (r.ip && String(r.ip));
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

// Parse a subnet argument into the list of host IPs to probe.
// Accepts "a.b.c.d/24", "a.b.c.0/24", or a bare "a.b.c" prefix (treated as /24). Only /24 is
// supported so a scan is bounded to 254 hosts and cannot be pointed at an enormous range.
// Returns null for anything invalid; callers treat null as "no hosts" / a 400.
function parseSubnet(subnet) {
  if (!subnet || typeof subnet !== 'string') return null;
  const m = subnet.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const oct = [m[1], m[2], m[3]].map(Number);
  if (oct.some((o) => o > 255)) return null;
  if (m[4] != null && Number(m[4]) > 255) return null;
  const cidr = m[5] != null ? Number(m[5]) : 24;
  if (cidr !== 24) return null; // only a /24 sweep is supported
  const base = `${oct[0]}.${oct[1]}.${oct[2]}`;
  const hosts = [];
  for (let h = 1; h <= 254; h++) hosts.push(`${base}.${h}`);
  return hosts;
}

// SSDP passive listen. Joins the standard multicast group and reads announcement beacons for
// the time box, then resolves the deduped Bambu records. Never throws or rejects.
function discoverSSDP(opts = {}) {
  const timeoutMs     = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const port          = opts.port != null ? opts.port : SSDP_PORT;
  const multicastAddr = opts.multicastAddr || SSDP_MULTICAST_ADDR;

  return new Promise((resolve) => {
    const found = new Map();
    let socket;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (socket) socket.close(); } catch (_) { /* ignore */ }
      resolve(dedupe([...found.values()]));
    };

    const timer = setTimeout(finish, timeoutMs);

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      // getStatus-style contract: a socket error must resolve, never throw out of the module.
      socket.on('error', () => finish());
      socket.on('message', (msg, rinfo) => {
        try {
          const rec = parseSsdpPacket(msg, rinfo);
          if (rec) {
            const key = rec.serial || rec.ip;
            if (key && !found.has(key)) found.set(key, rec);
          }
        } catch (_) { /* ignore one malformed packet, keep listening */ }
      });
      socket.bind(port, () => {
        try { socket.addMembership(multicastAddr); } catch (_) { /* group join best-effort */ }
      });
    } catch (_) {
      finish();
    }
  });
}

// TCP-connect to one port. Resolves true if the connection opens, false on refuse/timeout/error.
function probePort(ip, port, connectTimeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let sock;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { if (sock) sock.destroy(); } catch (_) { /* ignore */ }
      resolve(result);
    };
    try {
      sock = new net.Socket();
      sock.setTimeout(connectTimeoutMs);
      sock.once('connect', () => settle(true));
      sock.once('timeout', () => settle(false));
      sock.once('error',   () => settle(false));
      sock.connect(port, ip);
    } catch (_) {
      settle(false);
    }
  });
}

// Fingerprint a single host: a Bambu printer answers on at least one LAN service port.
async function probeHost(ip, ports, connectTimeoutMs) {
  const results = await Promise.all(ports.map((p) => probePort(ip, p, connectTimeoutMs)));
  if (!results.some(Boolean)) return null;
  // A TCP probe cannot authenticate, so it yields address only; identity fields stay null.
  return { name: null, model: null, serial: null, ip, source: 'scan' };
}

// IP-range TCP probe. Sweeps the /24 for hosts answering on a Bambu LAN service port, batched
// and time-boxed. Never throws or rejects; returns [] on a bad subnet or any internal error.
async function discoverScan(opts = {}) {
  try {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const ports     = opts.ports || BAMBU_LAN_PORTS;
    const hosts     = parseSubnet(opts.subnet);
    if (!hosts || hosts.length === 0) return [];

    const connectTimeoutMs = Math.max(150, Math.min(opts.connectTimeoutMs || DEFAULT_PROBE_MS, timeoutMs));
    const deadline = Date.now() + timeoutMs;
    const found = [];

    for (let i = 0; i < hosts.length && Date.now() < deadline; i += SCAN_BATCH) {
      const batch = hosts.slice(i, i + SCAN_BATCH);
      const recs = await Promise.all(
        batch.map((ip) => probeHost(ip, ports, connectTimeoutMs).catch(() => null))
      );
      for (const r of recs) if (r) found.push(r);
    }
    return dedupe(found);
  } catch (_) {
    return [];
  }
}

module.exports = {
  discoverSSDP,
  discoverScan,
  parseSsdpPacket,
  parseSubnet,
  dedupe,
  SSDP_MULTICAST_ADDR,
  SSDP_PORT,
  BAMBU_LAN_PORTS,
  DEFAULT_TIMEOUT_MS,
};
