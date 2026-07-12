// Credential redaction (PR 3). Closes audit findings routes-credentials #3/#18/#23,
// client-leak #7, db-backup #36, the CSV-echo note (printers.js:470), the settings
// read-path note (settings.js:9), and the serial-in-event-note finding (printers.js:210).
//
// The invariant under test: no printer-returning endpoint ever includes an api_key
// property, and serial_number is always masked to '****' + last4. Writes still accept
// api_key/serial_number; an empty-string api_key on PUT must NOT wipe the stored key,
// and clear_api_key: true must.
//
// House idiom: in-memory DB, inline schema, route factory mounted on a throwaway app,
// driven with supertest. server/index.js is never imported, so the inline operator
// endpoints (set-ready, set-ready-batch, recommission) cannot be exercised here; their
// response shape is guaranteed instead by the sanitizePrinter unit tests below plus the
// manual edits in server/index.js that route their res.json through sanitizePrinter.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const { sanitizePrinter, sanitizePrinters, maskSerial } = require('../lib/sanitize-printer');

// Mock the event-log helper so the router does not open the real server/db.js file DB
// (server/events.js requires it at module load). This also lets us assert exactly what
// note text the PUT handler writes for a serial-number change.
jest.mock('../events', () => ({ insert: jest.fn() }));

// ── Unit tests for the shared sanitizer ───────────────────────────────────────
describe('sanitize-printer', () => {
  test('maskSerial masks to last 4, leaves null and empty untouched', () => {
    expect(maskSerial('01S00A123456789')).toBe('****6789');
    expect(maskSerial('ABCD')).toBe('****ABCD');
    expect(maskSerial('12')).toBe('****12');
    expect(maskSerial(null)).toBeNull();
    expect(maskSerial('')).toBe('');
  });

  test('sanitizePrinter strips api_key and reports presence as api_key_set', () => {
    const out = sanitizePrinter({ id: 1, name: 'A', api_key: 'secret', serial_number: '01S00A123456789' });
    expect(out).not.toHaveProperty('api_key');
    expect(out.api_key_set).toBe(1);
    expect(out.serial_number).toBe('****6789');
    expect(out.id).toBe(1);
    expect(out.name).toBe('A');
  });

  test('api_key_set is 0 when no key is stored (empty string)', () => {
    expect(sanitizePrinter({ api_key: '' }).api_key_set).toBe(0);
    expect(sanitizePrinter({ api_key: null }).api_key_set).toBe(0);
    expect(sanitizePrinter({}).api_key_set).toBe(0);
  });

  test('does not mutate its input and preserves computed columns', () => {
    const row = { id: 1, api_key: 'k', serial_number: 'X1234', has_active_job: 1, last_parts_per_plate: 4 };
    const out = sanitizePrinter(row);
    expect(row.api_key).toBe('k'); // original untouched
    expect(out.has_active_job).toBe(1);
    expect(out.last_parts_per_plate).toBe(4);
  });

  test('sanitizePrinters maps over an array', () => {
    const out = sanitizePrinters([{ api_key: 'a', serial_number: 'AAAA1' }, { api_key: '', serial_number: null }]);
    expect(out[0].api_key_set).toBe(1);
    expect(out[0].serial_number).toBe('****AAA1');
    expect(out[1].api_key_set).toBe(0);
    expect(out[1].serial_number).toBeNull();
    expect(out.every(p => !('api_key' in p))).toBe(true);
  });

  test('passes non-object input through unchanged', () => {
    expect(sanitizePrinter(null)).toBeNull();
    expect(sanitizePrinter(undefined)).toBeUndefined();
    expect(sanitizePrinters(null)).toBeNull();
  });
});

// ── Shared schema for route-level tests ────────────────────────────────────────
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printer_groups (
      name        TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL UNIQUE,
      ip                 TEXT NOT NULL,
      api_key            TEXT NOT NULL DEFAULT '',
      group_name         TEXT,
      type               TEXT DEFAULT 'prusa',
      model              TEXT NOT NULL,
      status             TEXT DEFAULT 'UNKNOWN',
      is_held            INTEGER DEFAULT 1,
      is_active          INTEGER DEFAULT 1,
      created_at         INTEGER NOT NULL,
      decommissioned_at  INTEGER,
      decommission_note  TEXT,
      serial_number      TEXT DEFAULT '',
      loaded_material    TEXT,
      loaded_color       TEXT
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, material_grams REAL, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER NOT NULL,
      event_type TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE filament_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE filament_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL REFERENCES filament_types(id),
      name TEXT NOT NULL, hex_color TEXT, UNIQUE(type_id, name)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO printer_models (model_id, label, connector) VALUES ('x1c', 'Bambu X1 Carbon', 'bambu')`).run();
  return db;
}

function seedPrinter(db, o = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, api_key, model, type, status, is_held, is_active, created_at, serial_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.name ?? `P_${Math.random().toString(36).slice(2)}`,
    o.ip ?? '192.168.1.50',
    o.api_key ?? 'AccessCode123',
    o.model ?? 'x1c',
    o.type ?? 'bambu',
    o.status ?? 'FINISHED',
    o.is_held ?? 1,
    o.is_active ?? 1,
    now,
    o.serial_number ?? '01S00A123456789'
  ).lastInsertRowid;
}

// Assert a printer-shaped response body has been redacted.
function expectRedacted(printer) {
  expect(printer).not.toHaveProperty('api_key');
  expect(printer).toHaveProperty('api_key_set');
  if (printer.serial_number != null && printer.serial_number !== '') {
    expect(printer.serial_number.startsWith('****')).toBe(true);
    expect(printer.serial_number).not.toMatch(/00A12345/); // no raw serial body
  }
}

// ── Printers router ────────────────────────────────────────────────────────────
describe('printers router credential redaction', () => {
  let db, app;
  beforeEach(() => {
    // Route files declare their Express router at module scope, so a second require() in
    // this process would reuse that router with a stale db closure from a previous test.
    // resetModules() forces a fresh module (and router) bound to this test's db.
    jest.resetModules();
    db = freshDb();
    app = express();
    app.use(express.json());
    app.use('/api/printers', require('../routes/printers')(db));
  });

  test('GET /api/printers (list) redacts every row', async () => {
    seedPrinter(db, { name: 'A', is_active: 1 });
    seedPrinter(db, { name: 'B', is_active: 1, api_key: '' });
    const res = await request(app).get('/api/printers');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    res.body.forEach(expectRedacted);
    const a = res.body.find(p => p.name === 'A');
    const b = res.body.find(p => p.name === 'B');
    expect(a.api_key_set).toBe(1);
    expect(a.serial_number).toBe('****6789');
    expect(b.api_key_set).toBe(0);
  });

  test('GET /api/printers/decommissioned redacts every row', async () => {
    seedPrinter(db, { name: 'Dead', is_active: 0 });
    const res = await request(app).get('/api/printers/decommissioned');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expectRedacted(res.body[0]);
  });

  test('GET /api/printers/:id redacts', async () => {
    const id = seedPrinter(db);
    const res = await request(app).get(`/api/printers/${id}`);
    expect(res.status).toBe(200);
    expectRedacted(res.body);
    expect(res.body.serial_number).toBe('****6789');
  });

  test('POST /api/printers 201 body is redacted', async () => {
    const res = await request(app).post('/api/printers').send({
      name: 'New', ip: '10.0.0.9', api_key: 'brandNewKey', serial_number: 'SN00009999', type: 'bambu', model: 'x1c',
    });
    expect(res.status).toBe(201);
    expectRedacted(res.body);
    expect(res.body.api_key_set).toBe(1);
    expect(res.body.serial_number).toBe('****9999');
    // Real value still persisted
    expect(db.prepare('SELECT api_key FROM printers WHERE id = ?').get(res.body.id).api_key).toBe('brandNewKey');
  });

  test('PUT /api/printers/:id response is redacted', async () => {
    const id = seedPrinter(db);
    const res = await request(app).put(`/api/printers/${id}`).send({ ip: '10.0.0.2' });
    expect(res.status).toBe(200);
    expectRedacted(res.body);
  });

  test('POST /:id/decommission and /:id/complete-and-decommission responses are redacted', async () => {
    const id1 = seedPrinter(db, { name: 'D1' });
    const r1 = await request(app).post(`/api/printers/${id1}/decommission`).send({});
    expect(r1.status).toBe(200);
    expectRedacted(r1.body);

    const id2 = seedPrinter(db, { name: 'D2' });
    const r2 = await request(app).post(`/api/printers/${id2}/complete-and-decommission`).send({});
    expect(r2.status).toBe(200);
    expectRedacted(r2.body);
  });

  test('POST /:id/link-job response is redacted', async () => {
    const printerId = seedPrinter(db, { name: 'L1' });
    const now = Date.now();
    const proj = db.prepare(`INSERT INTO projects (name, created_at, updated_at) VALUES ('P', ?, ?)`).run(now, now).lastInsertRowid;
    const part = db.prepare(`INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (?, 'pt', 10, ?, ?)`).run(proj, now, now).lastInsertRowid;
    const gc = db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'x1c', 'f.gcode', 'f.gcode', 4, ?)`).run(part, now).lastInsertRowid;
    const job = db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, ?, ?, 4, 'failed', ?)`).run(part, printerId, gc, now).lastInsertRowid;
    const res = await request(app).post(`/api/printers/${printerId}/link-job`).send({ job_id: job });
    expect(res.status).toBe(200);
    expectRedacted(res.body);
  });

  test('PUT with empty-string api_key does NOT wipe the stored key', async () => {
    const id = seedPrinter(db, { api_key: 'KEEPME' });
    const res = await request(app).put(`/api/printers/${id}`).send({ ip: '10.0.0.3', api_key: '' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT api_key FROM printers WHERE id = ?').get(id).api_key).toBe('KEEPME');
    expect(res.body.api_key_set).toBe(1);
  });

  test('PUT with a new api_key updates it', async () => {
    const id = seedPrinter(db, { api_key: 'OLD' });
    const res = await request(app).put(`/api/printers/${id}`).send({ api_key: 'NEWKEY' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT api_key FROM printers WHERE id = ?').get(id).api_key).toBe('NEWKEY');
    expect(res.body.api_key_set).toBe(1);
  });

  test('PUT with clear_api_key: true wipes the stored key', async () => {
    const id = seedPrinter(db, { api_key: 'WIPEME' });
    const res = await request(app).put(`/api/printers/${id}`).send({ clear_api_key: true });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT api_key FROM printers WHERE id = ?').get(id).api_key).toBe('');
    expect(res.body.api_key_set).toBe(0);
  });

  test('PUT serial-number change does not write the raw serial into the event note', async () => {
    const events = require('../events');
    events.insert.mockClear();
    const id = seedPrinter(db, { serial_number: '' });
    const res = await request(app).put(`/api/printers/${id}`).send({ serial_number: '01S00A987654321' });
    expect(res.status).toBe(200);
    const notes = events.insert.mock.calls
      .filter(c => c[1] === 'info_changed')
      .map(c => c[2]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some(n => n.includes('01S00A987654321'))).toBe(false);
    expect(notes.some(n => /Serial number/i.test(n))).toBe(true);
  });

  test('CSV import flagged rows echo api_key_set, never the raw api_key', async () => {
    // Row is flagged because the model is not registered — the row carries an access code.
    const csv = 'name,ip,api_key,serial_number,type,model\nBadModel,10.0.0.7,SuperSecretCode,SN12340000,bambu,not_a_model\n';
    const res = await request(app)
      .post('/api/printers/import')
      .attach('file', Buffer.from(csv), 'printers.csv');
    expect(res.status).toBe(200);
    expect(res.body.flagged.length).toBe(1);
    const row = res.body.flagged[0].row;
    expect(row).not.toHaveProperty('api_key');
    expect(row.api_key_set).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('SuperSecretCode');
  });
});

// ── Dashboard ──────────────────────────────────────────────────────────────────
describe('dashboard credential redaction', () => {
  test('GET /api/dashboard redacts printer rows but keeps stats intact', async () => {
    jest.resetModules();
    const db = freshDb();
    seedPrinter(db, { name: 'DashA', status: 'PRINTING', is_held: 0 });
    seedPrinter(db, { name: 'DashB', status: 'IDLE', is_held: 0 });
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard')(db));
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.printers.length).toBe(2);
    res.body.printers.forEach(expectRedacted);
    // Stats still derived correctly from the raw rows before redaction
    expect(res.body.stats.printing).toBe(1);
    expect(res.body.stats.idle).toBe(1);
  });
});

// ── Backup export / restore ─────────────────────────────────────────────────────
describe('backup credential handling', () => {
  let db, app;
  beforeEach(() => {
    db = freshDb();
    seedPrinter(db, { name: 'Bk1', api_key: 'BackupSecret', serial_number: '01S00A123456789' });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('farm_name', 'Test Farm')`).run();
    jest.resetModules();
    app = express();
    app.use(express.json());
    app.use('/api/backup', require('../routes/backup')(db));
  });

  test('default export excludes api_key but keeps serial_number', async () => {
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);
    expect(res.body.printers[0]).not.toHaveProperty('api_key');
    expect(res.body.printers[0].serial_number).toBe('01S00A123456789'); // unmasked in backup
    expect(JSON.stringify(res.body.printers)).not.toContain('BackupSecret');
  });

  test('?include_credentials=true includes api_key', async () => {
    const res = await request(app).get('/api/backup?include_credentials=true');
    expect(res.status).toBe(200);
    expect(res.body.printers[0].api_key).toBe('BackupSecret');
  });

  test('restore of a credential-less backup sets api_key to empty and warns', async () => {
    const exportRes = await request(app).get('/api/backup'); // default: no api_key
    const tmp = path.join(os.tmpdir(), `redaction-restore-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(exportRes.body));
    try {
      const res = await request(app).post('/api/backup/restore').attach('file', tmp);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.printers_without_credentials).toBe(1);
      expect(db.prepare('SELECT api_key FROM printers WHERE name = ?').get('Bk1').api_key).toBe('');
      // serial survives the round-trip
      expect(db.prepare('SELECT serial_number FROM printers WHERE name = ?').get('Bk1').serial_number).toBe('01S00A123456789');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  test('restore of a full backup keeps the credential and reports zero warnings', async () => {
    const exportRes = await request(app).get('/api/backup?include_credentials=true');
    const tmp = path.join(os.tmpdir(), `redaction-restore-full-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(exportRes.body));
    try {
      const res = await request(app).post('/api/backup/restore').attach('file', tmp);
      expect(res.status).toBe(200);
      expect(res.body.printers_without_credentials).toBe(0);
      expect(db.prepare('SELECT api_key FROM printers WHERE name = ?').get('Bk1').api_key).toBe('BackupSecret');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});

// ── Settings read-path filtering ─────────────────────────────────────────────────
describe('settings read-path filtering', () => {
  test('GET /api/settings returns only allowlisted keys', async () => {
    jest.resetModules();
    const db = freshDb();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('farm_name', 'Test Farm')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '5')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('auth_secret', 'do-not-leak')`).run();
    const app = express();
    app.use(express.json());
    app.use('/api/settings', require('../routes/settings')(db));
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.farm_name).toBe('Test Farm');
    expect(res.body.dispatch_batch_size).toBe('5');
    expect(res.body).not.toHaveProperty('auth_secret');
    expect(JSON.stringify(res.body)).not.toContain('do-not-leak');
  });
});
