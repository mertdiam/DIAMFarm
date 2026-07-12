// Locks in the scheduler's dispatch-safety invariants before the fork's feature
// PRs touch the surrounding code. These are the properties the Phase 0 audit
// flagged as the highest untested risks (audit findings 33, 32, and the
// dispatch-lock/ceiling behavior): a held printer is never dispatched to, a
// single open plate is claimed by exactly one printer, queue order and model
// targeting are respected, and the UPLOAD_CONFLICT retry waits the long window.
//
// Idiom copied from scheduler-file.test.js and scheduler-targeting.test.js:
// in-memory DB with an inline minimal schema, a mocked driver registry, a real
// G-code file on disk (the scheduler checks fs.existsSync before dispatching),
// and _dispatchToPrinter driven directly.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
  deleteFile: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../notifications', () => ({ add: jest.fn() }));
jest.mock('../events', () => ({ insert: jest.fn() }));

const notifications = require('../notifications');
const JobScheduler  = require('../scheduler');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// A single real file on disk shared by all tests. Every gcode row points at it,
// so the scheduler's fs.existsSync gate passes and control reaches the driver.
let gcodeFilename;
beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  gcodeFilename = `lock_test_${Date.now()}.bgcode`;
  fs.writeFileSync(path.join(GCODE_DIR, gcodeFilename), 'G28');
});
afterAll(() => {
  try { fs.unlinkSync(path.join(GCODE_DIR, gcodeFilename)); } catch (_) {}
});

beforeEach(() => {
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
  jest.clearAllMocks();
});

// ── Schema + seed helpers ───────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL, type TEXT DEFAULT 'prusa',
      group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT,
      allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10');
  `);
  return db;
}

function seedPrinter(db, overrides = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, type, group_name, loaded_material, loaded_color, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    overrides.name  ?? `P_${now}_${Math.random().toString(36).slice(2, 7)}`,
    overrides.model ?? 'mk4s',
    overrides.type  ?? 'prusa',
    overrides.group_name ?? null,
    overrides.loaded_material ?? null,
    overrides.loaded_color ?? null,
    overrides.status ?? 'IDLE',
    overrides.is_held ?? 0,
    now
  ).lastInsertRowid;
}

function seedProject(db, { priority = 0 } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, priority, created_at, updated_at)
     VALUES ('Proj', 'active', ?, ?, ?)`
  ).run(priority, now, now).lastInsertRowid;
}

function seedPart(db, projectId, { name = 'Part', targetQty = 10, completedQty = 0, sortOrder = 0 } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(projectId, name, targetQty, completedQty, sortOrder, now, now).lastInsertRowid;
}

function seedGcode(db, partId, { model = 'mk4s', partsPerPlate = 2 } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(partId, model, gcodeFilename, gcodeFilename, partsPerPlate, now).lastInsertRowid;
}

// A printer object as _dispatchToPrinter receives it (the event/sweep callers
// pass the printer row). id must match a seeded row so the fresh re-read works.
function printerObj(db, id) {
  return db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
}

// ── Hold gate ────────────────────────────────────────────────────────────────
// audit finding 33: the "no auto-redispatch before operator sign-off" property.

describe('hold gate - a held printer never receives a dispatch', () => {
  test('_dispatchToPrinter refuses a printer whose DB row is held', async () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    seedGcode(db, partId);
    const printerId = seedPrinter(db, { is_held: 1 });
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(printerObj(db, printerId));

    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
    // No probe job row must be left behind.
    const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    expect(jobCount).toBe(0);
  });

  test('hold gate reads is_held from the DB, not the (stale) printer object passed in', async () => {
    // Regression guard for finding 33: a caller that hands in a printer object
    // captured while is_held was 0 must still be refused once the DB says held.
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    seedGcode(db, partId);
    const printerId = seedPrinter(db, { is_held: 1 });
    const scheduler = new JobScheduler(db, { on: () => {} });

    const staleObject = { ...printerObj(db, printerId), is_held: 0 };
    const jobId = await scheduler._dispatchToPrinter(staleObject);

    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });

  test('sweepIdlePrinters excludes held printers from the eligible set', () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    seedGcode(db, partId);
    const freeId = seedPrinter(db, { name: 'free',  is_held: 0, status: 'IDLE' });
    seedPrinter(db, { name: 'held', is_held: 1, status: 'IDLE' });

    const scheduler = new JobScheduler(db, { on: () => {} });
    // Capture what the sweep considers eligible without running real dispatch.
    let sweptPrinters = null;
    scheduler._sweepInBatches = jest.fn((printers) => { sweptPrinters = printers; return Promise.resolve(); });

    scheduler.sweepIdlePrinters();

    expect(sweptPrinters).not.toBeNull();
    expect(sweptPrinters.map(p => p.id)).toEqual([freeId]);
  });
});

// ── Dispatch lock / ceiling: one open plate → exactly one printer ─────────────

describe('dispatch lock - a single open plate is claimed exactly once', () => {
  test('two idle printers, one part needing one plate: only one job is created', async () => {
    // target_qty 2, parts_per_plate 2 → a single plate fully covers the part.
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 2 });
    seedGcode(db, partId, { partsPerPlate: 2 });
    const p1 = seedPrinter(db);
    const p2 = seedPrinter(db);
    const scheduler = new JobScheduler(db, { on: () => {} });

    const job1 = await scheduler._dispatchToPrinter(printerObj(db, p1));
    const job2 = await scheduler._dispatchToPrinter(printerObj(db, p2));

    expect(job1).not.toBeNull();
    expect(job2).toBeNull(); // ceiling already covered by the first plate
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);
    const jobs = db.prepare("SELECT * FROM jobs WHERE part_id = ? AND status IN ('uploading','printing')").all(partId);
    expect(jobs).toHaveLength(1);
  });

  test('re-entrant dispatch while the first upload is still in flight creates only one job', async () => {
    // The guard+INSERT run synchronously before the first await, so a second
    // dispatch entering during the first upload sees the probe and backs off.
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 2 });
    seedGcode(db, partId, { partsPerPlate: 2 });
    const p1 = seedPrinter(db);
    const p2 = seedPrinter(db);
    const scheduler = new JobScheduler(db, { on: () => {} });

    let releaseUpload;
    mockDriver.uploadAndPrint.mockReturnValueOnce(new Promise(r => { releaseUpload = r; }));

    const first = scheduler._dispatchToPrinter(printerObj(db, p1)); // suspends at upload
    const second = await scheduler._dispatchToPrinter(printerObj(db, p2));

    expect(second).toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);

    releaseUpload();
    const firstId = await first;
    expect(firstId).not.toBeNull();

    const activeJobs = db.prepare("SELECT * FROM jobs WHERE status IN ('uploading','printing')").all();
    expect(activeJobs).toHaveLength(1);
  });
});

// ── Ceiling accounting across differing parts_per_plate ───────────────────────

describe('ceiling - parts_per_plate accounting stops over-dispatch', () => {
  test('dispatch proceeds while in-progress parts are below the remaining target', async () => {
    // remaining 6, one in-progress plate of 2 → still short, so dispatch.
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 6 });
    seedGcode(db, partId, { partsPerPlate: 2 });
    const busy = seedPrinter(db, { status: 'PRINTING' });
    const idle = seedPrinter(db);
    // An existing in-progress plate on the busy printer.
    db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
                VALUES (?, ?, 1, 2, 'printing', ?, ?)`).run(partId, busy, Date.now(), Date.now());

    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter(printerObj(db, idle));

    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);
  });

  test('dispatch is skipped when in-progress parts already cover the remaining target', async () => {
    // remaining 2, one in-progress plate of 2 → covered, so no dispatch and no probe left behind.
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 2 });
    seedGcode(db, partId, { partsPerPlate: 2 });
    const busy = seedPrinter(db, { status: 'PRINTING' });
    const idle = seedPrinter(db);
    db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
                VALUES (?, ?, 1, 2, 'printing', ?, ?)`).run(partId, busy, Date.now(), Date.now());

    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter(printerObj(db, idle));

    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
    // The probe inserted during the ceiling check must have been deleted.
    const jobCount = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE part_id = ?").get(partId).n;
    expect(jobCount).toBe(1); // only the pre-existing in-progress job remains
  });

  test('completed_qty counts toward the ceiling: a nearly-complete part is not over-dispatched', async () => {
    // target 4, completed 2, remaining 2; one in-progress plate of 2 covers it.
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 2 });
    seedGcode(db, partId, { partsPerPlate: 2 });
    const busy = seedPrinter(db, { status: 'PRINTING' });
    const idle = seedPrinter(db);
    db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
                VALUES (?, ?, 1, 2, 'printing', ?, ?)`).run(partId, busy, Date.now(), Date.now());

    const scheduler = new JobScheduler(db, { on: () => {} });
    const jobId = await scheduler._dispatchToPrinter(printerObj(db, idle));

    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  });
});

// ── Queue ordering + model targeting ──────────────────────────────────────────

describe('queue ordering and model targeting', () => {
  test('the higher-priority project (lower priority number) is dispatched first', async () => {
    const db = makeDb();
    const lowPriProject  = seedProject(db, { priority: 10 });
    const highPriProject = seedProject(db, { priority: 1 });
    const lowPart  = seedPart(db, lowPriProject,  { name: 'low' });
    const highPart = seedPart(db, highPriProject, { name: 'high' });
    seedGcode(db, lowPart);
    seedGcode(db, highPart);
    const printerId = seedPrinter(db);
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(printerObj(db, printerId));

    expect(jobId).not.toBeNull();
    const job = db.prepare('SELECT part_id FROM jobs WHERE id = ?').get(jobId);
    expect(job.part_id).toBe(highPart);
  });

  test('within one project, the lower sort_order part is dispatched first', async () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const first  = seedPart(db, projectId, { name: 'first',  sortOrder: 0 });
    const second = seedPart(db, projectId, { name: 'second', sortOrder: 5 });
    seedGcode(db, first);
    seedGcode(db, second);
    const printerId = seedPrinter(db);
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(printerObj(db, printerId));

    const job = db.prepare('SELECT part_id FROM jobs WHERE id = ?').get(jobId);
    expect(job.part_id).toBe(first);
  });

  test('a printer whose model has no matching G-code never receives a job', async () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    seedGcode(db, partId, { model: 'mk4s' });
    // Printer is an X1C; the only G-code targets mk4s.
    const printerId = seedPrinter(db, { model: 'x1c' });
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(printerObj(db, printerId));

    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
    const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    expect(jobCount).toBe(0);
  });
});

// ── UPLOAD_CONFLICT retry timing ──────────────────────────────────────────────
// A 409 (transfer already in progress) waits 60s before retrying, far longer
// than the 5s used for other errors. Fake timers let us assert the exact window.

describe('UPLOAD_CONFLICT - waits the long (60s) window before retrying', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('does not retry at 5s but does after 60s, then succeeds on the retry', async () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    seedGcode(db, partId);
    const printerId = seedPrinter(db);
    const scheduler = new JobScheduler(db, { on: () => {} });

    const conflict = new Error('transfer already in progress');
    conflict.code = 'UPLOAD_CONFLICT';
    mockDriver.uploadAndPrint
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(undefined);

    const promise = scheduler._dispatchToPrinter(printerObj(db, printerId));

    // Let the first rejection settle so the retry wait is scheduled.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);

    // A 5s advance is enough for an ordinary error but not for a conflict.
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);

    // Completing the 60s window triggers the retry.
    await jest.advanceTimersByTimeAsync(55000);
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(2);

    const jobId = await promise;
    expect(jobId).not.toBeNull();
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('printing');
  });

  test('persistent UPLOAD_CONFLICT (printer not printing) holds the printer, job left uploading', async () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    seedGcode(db, partId);
    const printerId = seedPrinter(db);
    const scheduler = new JobScheduler(db, { on: () => {} });

    const conflict = new Error('transfer already in progress');
    conflict.code = 'UPLOAD_CONFLICT';
    mockDriver.uploadAndPrint.mockRejectedValue(conflict);
    mockDriver.checkIfPrinting.mockResolvedValue(false);

    const promise = scheduler._dispatchToPrinter(printerObj(db, printerId));
    await jest.runAllTimersAsync();
    const jobId = await promise;

    expect(jobId).toBeNull();
    // Never auto-fail here: the operator confirms via Fleet. Job stays 'uploading'.
    const job = db.prepare("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get();
    expect(job.status).toBe('uploading');
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(1);
    expect(notifications.add).toHaveBeenCalledTimes(1);
  });
});
