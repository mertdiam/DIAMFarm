// Tests for POST /api/printers/discover and POST /api/printers/discover/add.
// Uses an in-memory SQLite DB and the route factory mounted on a throwaway Express app.
// The discovery module is mocked so no real sockets are opened; the route's own logic
// (already_known cross-check, draft creation, dedup skip, validation) is what is exercised.
// A separate block mounts requireRole('admin') in front, mirroring the ADMIN_ONLY wiring in
// server/index.js, to prove the gate without importing server/index.js.

jest.mock('../lib/discovery');

const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

const discovery = require('../lib/discovery');
const requireRoleFactory = require('../middleware/require-role');

let db;
let app;

function buildSchema(database) {
  database.exec(`
    CREATE TABLE printers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      ip               TEXT NOT NULL,
      api_key          TEXT NOT NULL DEFAULT '',
      group_name       TEXT,
      type             TEXT DEFAULT 'prusa',
      model            TEXT NOT NULL,
      status           TEXT DEFAULT 'UNKNOWN',
      is_held          INTEGER DEFAULT 1,
      is_active        INTEGER DEFAULT 1,
      serial_number    TEXT DEFAULT '',
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    CREATE TABLE printer_groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  database.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('x1c', 'X1 Carbon', 'bambu')").run();
  database.prepare("INSERT INTO printer_models (model_id, label, connector) VALUES ('p1s', 'P1S', 'bambu')").run();
}

function seedPrinter(overrides = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, api_key, serial_number, model, type, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? `Printer_${now}_${Math.random()}`,
    overrides.ip ?? '10.0.0.1',
    overrides.api_key ?? 'SECRET',
    overrides.serial_number ?? '',
    overrides.model ?? 'x1c',
    overrides.type ?? 'bambu',
    overrides.is_active ?? 1,
    now,
  ).lastInsertRowid;
}

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  buildSchema(db);
  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM printers').run();
  db.prepare('DELETE FROM printer_groups').run();
});

// ── POST /api/printers/discover ────────────────────────────────────────────────

describe('POST /api/printers/discover', () => {
  test('400 when method is missing or invalid', async () => {
    const res = await request(app).post('/api/printers/discover').send({});
    expect(res.status).toBe(400);
    const res2 = await request(app).post('/api/printers/discover').send({ method: 'telepathy' });
    expect(res2.status).toBe(400);
  });

  test('ssdp success returns found list with per-row already_known flags', async () => {
    seedPrinter({ name: 'Known-A', serial_number: 'SNKNOWN', ip: '192.168.1.10' });
    discovery.discoverSSDP.mockResolvedValue([
      { name: 'Known By Serial', model: 'x1c', serial: 'SNKNOWN', ip: '192.168.1.99', source: 'ssdp' },
      { name: 'Brand New', model: 'p1s', serial: 'SNNEW', ip: '192.168.1.50', source: 'ssdp' },
    ]);

    const res = await request(app).post('/api/printers/discover').send({ method: 'ssdp' });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('ssdp');
    expect(res.body.count).toBe(2);
    const bySerial = Object.fromEntries(res.body.found.map((f) => [f.serial, f]));
    expect(bySerial.SNKNOWN.already_known).toBe(true); // matched an existing printer by serial
    expect(bySerial.SNNEW.already_known).toBe(false);
    expect(discovery.discoverSSDP).toHaveBeenCalledTimes(1);
  });

  test('already_known also matches by IP when serial differs', async () => {
    seedPrinter({ name: 'Known-B', serial_number: '', ip: '192.168.1.60' });
    discovery.discoverSSDP.mockResolvedValue([
      { name: null, model: null, serial: 'DIFFERENT', ip: '192.168.1.60', source: 'ssdp' },
    ]);
    const res = await request(app).post('/api/printers/discover').send({ method: 'ssdp' });
    expect(res.body.found[0].already_known).toBe(true);
  });

  test('empty result returns count 0', async () => {
    discovery.discoverSSDP.mockResolvedValue([]);
    const res = await request(app).post('/api/printers/discover').send({ method: 'ssdp' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.found).toEqual([]);
  });

  test('scan requires a valid subnet (400 when missing or unparseable)', async () => {
    discovery.parseSubnet.mockReturnValue(null);
    const missing = await request(app).post('/api/printers/discover').send({ method: 'scan' });
    expect(missing.status).toBe(400);
    const bad = await request(app).post('/api/printers/discover').send({ method: 'scan', subnet: 'garbage' });
    expect(bad.status).toBe(400);
    expect(discovery.discoverScan).not.toHaveBeenCalled();
  });

  test('scan success passes the subnet through and returns records', async () => {
    discovery.parseSubnet.mockReturnValue(['192.168.1.1']); // non-null => valid
    discovery.discoverScan.mockResolvedValue([
      { name: null, model: null, serial: null, ip: '192.168.1.42', source: 'scan' },
    ]);
    const res = await request(app).post('/api/printers/discover').send({ method: 'scan', subnet: '192.168.1.0/24' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.found[0].source).toBe('scan');
    expect(discovery.discoverScan).toHaveBeenCalledWith({ subnet: '192.168.1.0/24' });
  });

  test('response never carries an api_key field', async () => {
    discovery.discoverSSDP.mockResolvedValue([
      { name: 'X', model: 'x1c', serial: 'S1', ip: '1.2.3.4', source: 'ssdp' },
    ]);
    const res = await request(app).post('/api/printers/discover').send({ method: 'ssdp' });
    expect(JSON.stringify(res.body)).not.toMatch(/api_key/);
  });
});

// ── POST /api/printers/discover/add ────────────────────────────────────────────

describe('POST /api/printers/discover/add', () => {
  test('400 when printers array is missing or empty', async () => {
    expect((await request(app).post('/api/printers/discover/add').send({})).status).toBe(400);
    expect((await request(app).post('/api/printers/discover/add').send({ printers: [] })).status).toBe(400);
  });

  test('creates drafts with empty api_key, is_active=1, type from the model connector', async () => {
    const res = await request(app).post('/api/printers/discover/add').send({
      printers: [{ name: 'Draft_1', ip: '192.168.1.42', model: 'x1c', serial_number: 'SN1', group_name: 'Rack A' }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ added: 1, skipped: [] });

    const row = db.prepare('SELECT * FROM printers WHERE name = ?').get('Draft_1');
    expect(row.api_key).toBe('');
    expect(row.is_active).toBe(1);
    expect(row.is_held).toBe(1); // untouched: default hold, no new draft semantics
    expect(row.type).toBe('bambu');
    expect(row.serial_number).toBe('SN1');
    expect(row.group_name).toBe('Rack A');
    // Group auto-registration reused
    expect(db.prepare('SELECT 1 FROM printer_groups WHERE name = ?').get('Rack A')).toBeTruthy();
  });

  test('skips duplicates (by name, serial, or IP) and reports them', async () => {
    seedPrinter({ name: 'Existing', serial_number: 'DUPSERIAL', ip: '192.168.1.10' });

    const res = await request(app).post('/api/printers/discover/add').send({
      printers: [
        { name: 'Existing', ip: '9.9.9.9', model: 'x1c' },              // dup by name
        { name: 'NewName1', ip: '192.168.1.10', model: 'x1c' },          // dup by IP
        { name: 'NewName2', ip: '8.8.8.8', model: 'x1c', serial_number: 'DUPSERIAL' }, // dup by serial
        { name: 'ReallyNew', ip: '192.168.1.55', model: 'p1s', serial_number: 'FRESH' }, // added
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) c FROM printers').get().c).toBe(2); // existing + 1 new
  });

  test('400 on an unknown model, and nothing is inserted (whole batch rejected)', async () => {
    const res = await request(app).post('/api/printers/discover/add').send({
      printers: [
        { name: 'Good', ip: '192.168.1.70', model: 'x1c' },
        { name: 'Bad', ip: '192.168.1.71', model: 'not-a-model' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown model/);
    expect(db.prepare('SELECT COUNT(*) c FROM printers').get().c).toBe(0); // validated before any insert
  });

  test('400 when a row is missing name or ip', async () => {
    const res = await request(app).post('/api/printers/discover/add').send({
      printers: [{ ip: '192.168.1.72', model: 'x1c' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name, ip, and model/);
  });

  test('a draft is stored with no access code to leak (redaction holds by construction)', async () => {
    await request(app).post('/api/printers/discover/add').send({
      printers: [{ name: 'NoCode', ip: '192.168.1.80', model: 'x1c' }],
    });
    const id = db.prepare('SELECT id FROM printers WHERE name = ?').get('NoCode').id;
    const res = await request(app).get(`/api/printers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.api_key).toBeUndefined();   // sanitizePrinter strips it
    expect(res.body.api_key_set).toBe(0);        // and reports "not set"
  });
});

// ── Admin gate (mirrors server/index.js ADMIN_ONLY wiring) ─────────────────────

describe('admin gate on discovery routes', () => {
  let gatedApp;

  beforeAll(() => {
    const adminGate = requireRoleFactory('admin');
    gatedApp = express();
    gatedApp.use(express.json());
    // Fake auth context: role comes from a header, standing in for require-auth's req.user.
    gatedApp.use((req, _res, next) => { req.user = { role: req.get('x-test-role') || '' }; next(); });
    // Same two paths guarded in server/index.js ADMIN_ONLY.
    gatedApp.post('/api/printers/discover', adminGate);
    gatedApp.post('/api/printers/discover/add', adminGate);
    gatedApp.use('/api/printers', require('../routes/printers')(db));
  });

  test('operator is forbidden (403) on both discovery routes', async () => {
    discovery.discoverSSDP.mockResolvedValue([]);
    const d = await request(gatedApp).post('/api/printers/discover').set('x-test-role', 'operator').send({ method: 'ssdp' });
    expect(d.status).toBe(403);
    const a = await request(gatedApp).post('/api/printers/discover/add').set('x-test-role', 'operator').send({ printers: [] });
    expect(a.status).toBe(403);
  });

  test('admin passes the gate through to the route', async () => {
    discovery.discoverSSDP.mockResolvedValue([]);
    const d = await request(gatedApp).post('/api/printers/discover').set('x-test-role', 'admin').send({ method: 'ssdp' });
    expect(d.status).toBe(200);
  });
});
