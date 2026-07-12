// Locks in the scheduler's restart-recovery and status-replay behavior before
// the fork's feature PRs change the surrounding code. Unlike the other scheduler
// suites, these drive the scheduler through its real poller-event wiring
// (scheduler.start() subscribing to statusChange) so the event-to-handler path
// itself is exercised, and they construct a fresh scheduler (new startedAt) to
// stand in for a server restart.
//
// Coverage:
//   - No auto-redispatch before sign-off: a finished job holds the printer and
//     nothing dispatches until the hold is released.
//   - Stale-status replay: after a restart, a FINISHED reported by a printer
//     whose only job failed before startedAt must NOT credit completed_qty
//     (the phantom-part-credit / stale-replay class from CLAUDE.md).
//   - Restart mid-print: a 'printing' job left in the DB completes exactly once
//     when the printer reports FINISHED, with no duplicate credit.
//   - OFFLINE mid-job: the job stays recoverable (left 'printing', printer held),
//     the printer auto-unholds on return, and completion still credits once.
//
// Idiom copied from scheduler-finished.test.js: in-memory DB, inline schema,
// mocked drivers/notifications/events, _dispatchToPrinter stubbed so the
// no-job FINISHED branch cannot fire a real dispatch during assertions.

const EventEmitter = require('events');
const Database     = require('better-sqlite3');

const mockDriver = { deleteFile: jest.fn().mockResolvedValue(undefined) };
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../notifications', () => ({ add: jest.fn() }));
jest.mock('../events', () => ({ insert: jest.fn() }));

const JobScheduler = require('../scheduler');

afterEach(() => jest.clearAllMocks());

// ── Schema + seed helpers ───────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL, type TEXT DEFAULT 'bambu',
      status TEXT DEFAULT 'PRINTING', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
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

// Build a scheduler wired to a real EventEmitter poller and started, so that
// emitting poller events exercises the same subscription path the server uses.
// _dispatchToPrinter is stubbed to keep the no-job FINISHED branch inert.
function startedScheduler(db) {
  const poller = new EventEmitter();
  const scheduler = new JobScheduler(db, poller);
  scheduler.start();
  scheduler._dispatchToPrinter = jest.fn().mockResolvedValue(null);
  return { scheduler, poller };
}

function seedPrinter(db, overrides = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, type, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', ?, 'bambu', ?, ?, 1, ?)
  `).run(
    overrides.name ?? `P_${now}`,
    overrides.model ?? 'x1c',
    overrides.status ?? 'PRINTING',
    overrides.is_held ?? 0,
    now
  ).lastInsertRowid;
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
     VALUES (?, 'x1c', 'plate.3mf', 'plate.3mf', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(db, printerId, partId, gcodeId, status, { partsPerPlate = 4, startedAt, finishedAt } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(printerId, partId, gcodeId, partsPerPlate, status, startedAt ?? now, finishedAt ?? null, now).lastInsertRowid;
}

function row(db, id) {
  return db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
}

// ── No auto-redispatch before operator sign-off ───────────────────────────────

describe('no auto-redispatch before sign-off', () => {
  test('a finished job holds the printer and no new job is dispatched until the hold clears', () => {
    const db = makeDb();
    const { scheduler, poller } = startedScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { status: 'PRINTING', is_held: 0 });
    seedJob(db, printerId, partId, gcodeId, 'printing');

    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'FINISHED' });

    // Printer is held awaiting operator confirmation.
    expect(row(db, printerId).is_held).toBe(1);
    // The tracked job was credited exactly once and no follow-on dispatch ran.
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(4);
    expect(scheduler._dispatchToPrinter).not.toHaveBeenCalled();
  });
});

// ── Stale-status replay across a restart ──────────────────────────────────────
// A Bambu printer reports OFFLINE on the first poll after restart (MQTT still
// connecting), then a FINISHED latched from before the server started. The
// finished_at > startedAt gate must stop that stale state from crediting.

describe('stale-status replay - cold start must not credit a pre-restart failure', () => {
  test('FINISHED reported for a job that failed before this session does not credit', () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { status: 'OFFLINE', is_held: 0 });

    // The job was marked failed one minute before the (fresh) session started.
    const { scheduler, poller } = startedScheduler(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { finishedAt: scheduler.startedAt - 60_000 });

    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'FINISHED' });

    // Phantom credit must not happen: the stale failed job stays failed, count is untouched.
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(0);
    expect(db.prepare("SELECT status FROM jobs WHERE printer_id = ?").get(printerId).status).toBe('failed');
  });

  test('a job that failed after startedAt (transient mid-print disconnect) is recovered and credited once', () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { status: 'PRINTING', is_held: 0 });

    const { scheduler, poller } = startedScheduler(db);
    const jobId = seedJob(db, printerId, partId, gcodeId, 'failed', { finishedAt: scheduler.startedAt + 1000 });

    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'FINISHED' });

    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(4);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('finished');
  });
});

// ── Restart mid-print: resume tracking, complete exactly once ─────────────────

describe('restart recovery - a printing job left in the DB completes exactly once', () => {
  test('the printer reports PRINTING then FINISHED; the job is credited once, no duplicate', () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    // Restart scenario: the DB already holds a 'printing' job from before the restart.
    const printerId = seedPrinter(db, { status: 'PRINTING', is_held: 0 });
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'printing');

    const { poller } = startedScheduler(db);

    // First real poll after restart re-observes PRINTING (no-op), then FINISHED.
    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'PRINTING' });
    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'FINISHED' });

    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('finished');
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(4);

    // A second FINISHED (e.g. Bambu latching the state) must not credit again.
    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'FINISHED' });
    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(4);
    const finishedJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'finished'").get().n;
    expect(finishedJobs).toBe(1);
  });
});

// ── OFFLINE mid-job: recoverable, not stuck ───────────────────────────────────

describe('OFFLINE mid-job - job stays recoverable and credits once on return', () => {
  test('OFFLINE holds the printer but leaves the job printing', () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { status: 'PRINTING', is_held: 0 });
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'printing');

    const { poller } = startedScheduler(db);
    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'OFFLINE' });

    // Job is NOT failed or deleted: it must remain recoverable.
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('printing');
    expect(row(db, printerId).is_held).toBe(1);
  });

  test('printer returning to PRINTING auto-unholds, and a later FINISHED credits exactly once with no duplicate job', () => {
    const db = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { status: 'PRINTING', is_held: 0 });
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'printing');

    const { scheduler, poller } = startedScheduler(db);

    // Go offline (held, job kept), then come back printing (auto-unhold), then finish.
    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'OFFLINE' });
    // The scheduler re-reads is_held from the DB, so hand it the current row.
    db.prepare("UPDATE printers SET status = 'PRINTING' WHERE id = ?").run(printerId);
    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'PRINTING' });
    expect(row(db, printerId).is_held).toBe(0); // auto-unhold on recovery

    poller.emit('statusChange', { printer: row(db, printerId), newStatus: 'FINISHED' });

    expect(db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty).toBe(4);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('finished');
    // No duplicate dispatch happened during the offline/recovery cycle.
    expect(scheduler._dispatchToPrinter).not.toHaveBeenCalled();
    const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    expect(jobCount).toBe(1);
  });
});
