// Regression tests for TASK 6 audit criticals that live in server/scheduler.js.
//
// These drive the REAL scheduler (require('../scheduler')) against an in-memory DB,
// the same harness idiom as scheduler-finished.test.js, so they exercise the actual
// shipped code, not a copy.
//
// Findings covered (docs/internal/audit-findings.md):
//   FIX 3 (finding 6): stale-job auto-fail ran before the in-flight-upload guard, so a
//                      sweep during a live upload could mark the live job 'failed' and
//                      hold the printer, later enabling a phantom part credit.
//   FIX 4 (finding at the _handleFinished no-tracked-job branch): an untracked FINISHED
//                      auto-dispatched a new job onto an uncleared bed. It must instead
//                      hold the printer and notify, deferring to operator sign-off.

const Database     = require('better-sqlite3');
const JobScheduler = require('../scheduler');

// _handleFinished calls getDriver for SD-card cleanup on the happy path; _dispatchToPrinter
// resolves a driver only after the guards under test, so these paths never reach it. Mock
// anyway so the module never touches a real transport.
const mockDriver = { deleteFile: jest.fn().mockResolvedValue(undefined) };
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../events', () => ({ insert: jest.fn() }));
jest.mock('../notifications', () => ({ add: jest.fn(), list: jest.fn(() => []), dismiss: jest.fn() }));
const notifications = require('../notifications');

afterEach(() => jest.clearAllMocks());

// ── Schema + seed helpers ──────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL, type TEXT DEFAULT 'bambu',
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER, created_at INTEGER NOT NULL
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

function seedPrinter(db, { status = 'IDLE', isHeld = 0, model = 'mk4s', type = 'bambu' } = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, type, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', ?, ?, ?, ?, 1, ?)
  `).run(`P_${now}_${Math.random()}`, model, type, status, isHeld, now).lastInsertRowid;
}

function seedProject(db) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES ('Proj', 'active', 0, ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(db, projectId, { targetQty = 10, completedQty = 0 } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
     VALUES (?, 'Part A', ?, ?, 'open', 0, ?, ?)`
  ).run(projectId, targetQty, completedQty, now, now).lastInsertRowid;
}

function seedGcode(db, partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'mk4s', 'test.bgcode', 'test.bgcode', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

// Seeds an 'uploading' job that is already older than STALE_JOB_GRACE_MS (90s) so the
// stale-job auto-fail branch would fire if reached.
function seedOldUploadingJob(db, printerId, partId, gcodeId) {
  const old = Date.now() - 200000; // 200s ago, well past the 90s grace window
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, 4, 'uploading', NULL, NULL, ?)`
  ).run(printerId, partId, gcodeId, old).lastInsertRowid;
}

function printerRow(db, id) {
  return db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
}

// ── FIX 3: in-flight upload guard must run before the stale-job auto-fail ───────

describe('FIX 3 (finding 6): stale-job auto-fail must not kill a live upload', () => {
  test('a printer with an upload in flight is not auto-failed even when its job looks stale', async () => {
    const db        = makeDb();
    const scheduler = new JobScheduler(db, { on: () => {} });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    // Printer is IDLE (stale-eligible) with an old 'uploading' job, but the upload is
    // genuinely in flight (60s UPLOAD_CONFLICT wait / multi-minute transfer).
    const printerId = seedPrinter(db, { status: 'IDLE', isHeld: 0 });
    const jobId     = seedOldUploadingJob(db, printerId, partId, gcodeId);
    scheduler._activeUploads.add(printerId);

    await scheduler._dispatchToPrinter(printerRow(db, printerId));

    const job     = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    // Before the fix: the job is marked 'failed' and the printer is held (phantom-credit setup).
    expect(job.status).toBe('uploading');
    expect(printer.is_held).toBe(0);
  });

  test('a genuinely stale job with no in-flight upload is still auto-failed and held', async () => {
    // Guard: the reorder must not disable the legitimate stale-job cleanup.
    const db        = makeDb();
    const scheduler = new JobScheduler(db, { on: () => {} });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { status: 'IDLE', isHeld: 0 });
    const jobId     = seedOldUploadingJob(db, printerId, partId, gcodeId);
    // No _activeUploads entry, nothing is actually uploading.

    await scheduler._dispatchToPrinter(printerRow(db, printerId));

    const job     = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(job.status).toBe('failed');
    expect(printer.is_held).toBe(1);
  });
});

// ── FIX 4: untracked FINISHED must hold the printer, not auto-dispatch ──────────

describe('FIX 4: untracked FINISHED holds the printer for operator sign-off', () => {
  test('no tracked job on FINISHED holds the printer, notifies, and does not dispatch', () => {
    const db        = makeDb();
    const scheduler = new JobScheduler(db, { on: () => {} });
    const dispatchSpy = jest.spyOn(scheduler, '_dispatchToPrinter').mockResolvedValue(null);
    const printerId = seedPrinter(db, { status: 'FINISHED', isHeld: 0 });
    // No job seeded. An externally started print finished on an enrolled printer.

    scheduler._handleFinished(printerRow(db, printerId));

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(1);            // held for operator confirmation
    expect(dispatchSpy).not.toHaveBeenCalled(); // never dispatched onto an uncleared bed
    expect(notifications.add).toHaveBeenCalledTimes(1);
    expect(notifications.add.mock.calls[0][0]).toMatch(/untracked/i);
  });

  test('untracked FINISHED credits no parts', () => {
    const db        = makeDb();
    const scheduler = new JobScheduler(db, { on: () => {} });
    jest.spyOn(scheduler, '_dispatchToPrinter').mockResolvedValue(null);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 5 });
    const printerId = seedPrinter(db, { status: 'FINISHED', isHeld: 0 });

    scheduler._handleFinished(printerRow(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(5); // sacred: never credited without a tracked job
  });
});
