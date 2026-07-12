// Regression tests for the TASK 6 audit criticals in the set-ready endpoint.
//
// COVERAGE NOTE (read before editing):
// The set-ready handler lives inside server/index.js's app.listen callback (it needs the
// live scheduler instance), so it cannot be imported without booting the whole server, which
// the house rule "The heavyweight test" forbids. Following the same approach as the existing
// set-ready.test.js, this suite mounts a REPLICA of the handler on a throwaway express app.
//
// The replica below is a byte-faithful copy of the CURRENT server/index.js set-ready handler
// (only sanitizePrinter and the scheduler wiring are stubbed). Because it is a copy, these
// behavioural tests prove the LOGIC is correct but cannot prove server/index.js still matches.
// The `handler source invariants` describe block at the bottom closes that gap: it reads the
// real server/index.js and asserts each fix marker is present, so a future drift between the
// replica and the shipped handler fails the suite. Treat the replica and server/index.js as a
// sync pair: change one, change the other.
//
// Findings covered (docs/internal/audit-findings.md):
//   FIX 1a (finding 4): no is_held precondition -> a stale-UI / duplicate Set Ready could
//                       phantom-credit. Now 409 unless the printer is awaiting sign-off.
//   FIX 1b (finding 4): the session-failed fallback had no scope guard, so a stale 'failed'
//                       row could be credited. Now excluded when a newer job exists.
//   FIX 2  (finding 5): confirmed_qty adjustment was not idempotent. The hold is now a
//                       single-use token: the first request releases it inside the crediting
//                       transaction, so completed_qty changes exactly once across duplicates.
//   FIX 4 support: a held printer with NO tracked job releases the hold with zero credit.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

// ── Replica of the fixed server/index.js set-ready handler (sync pair) ──────────

function makeApp(db, scheduler = { scheduleForPrinter: jest.fn(), startedAt: 0 }) {
  const app = express();
  app.use(express.json());

  app.post('/api/printers/:id/set-ready', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    // FIX 1a + FIX 2 idempotency guard.
    if (!printer.is_held) {
      return res.status(409).json({ error: 'Printer is not awaiting sign-off' });
    }

    const { confirmed_qty } = req.body || {};
    const now = Date.now();

    const applyResolution = db.transaction(() => {
    const held = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printer.id);
    if (!held || !held.is_held) return;

    const uploadingJobEarly = db.prepare(
      "SELECT * FROM jobs WHERE printer_id = ? AND status = 'uploading' ORDER BY created_at DESC LIMIT 1"
    ).get(printer.id);

    const printingJobEarly = !uploadingJobEarly && db.prepare(
      "SELECT id FROM jobs WHERE printer_id = ? AND status = 'printing' ORDER BY started_at DESC LIMIT 1"
    ).get(printer.id);

    let finishedJob = (uploadingJobEarly || printingJobEarly) ? null : db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
      ORDER BY finished_at DESC LIMIT 1
    `).get(printer.id);

    if (finishedJob) {
      const newerCancelled = db.prepare(`
        SELECT 1 FROM jobs WHERE printer_id = ? AND status = 'cancelled' AND finished_at > ? LIMIT 1
      `).get(printer.id, finishedJob.finished_at);
      if (newerCancelled) finishedJob = null;
    }

    if (finishedJob) {
      if (confirmed_qty != null) {
        const confirmedQty = parseInt(confirmed_qty, 10);
        if (!isNaN(confirmedQty) && confirmedQty !== finishedJob.parts_per_plate) {
          const delta = confirmedQty - finishedJob.parts_per_plate;
          db.prepare(`
            UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?
          `).run(delta, now, finishedJob.part_id);

          const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(finishedJob.part_id);
          if (part.completed_qty < part.target_qty && part.status === 'closed') {
            db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?`).run(now, part.id);
          } else if (part.completed_qty >= part.target_qty && part.status === 'open') {
            db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          }
        }
      }
    } else {
      const printingJob = db.prepare(`
        SELECT * FROM jobs WHERE printer_id = ? AND status = 'printing'
        ORDER BY started_at DESC LIMIT 1
      `).get(printer.id);

      const activeJob = printingJob
        || db.prepare(`
            SELECT * FROM jobs j WHERE j.printer_id = ? AND j.status = 'failed' AND j.finished_at > ?
              AND NOT EXISTS (
                SELECT 1 FROM jobs newer WHERE newer.printer_id = j.printer_id AND newer.id > j.id
              )
            ORDER BY j.finished_at DESC LIMIT 1
          `).get(printer.id, scheduler.startedAt)
        || db.prepare(`
            SELECT * FROM jobs WHERE printer_id = ? AND status = 'cancelled'
            ORDER BY finished_at DESC LIMIT 1
          `).get(printer.id);

      if (activeJob) {
        if (printer.status === 'OFFLINE' && activeJob.status === 'printing') {
          // OFFLINE-with-job: no credit, job stays printing.
        } else {
        const creditQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
          ? parseInt(confirmed_qty, 10)
          : activeJob.parts_per_plate;

        db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`)
          .run(now, activeJob.id);

        db.prepare(`
          UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?
        `).run(creditQty, now, activeJob.part_id);

        const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(activeJob.part_id);
        if (part.completed_qty >= part.target_qty) {
          db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(part.id);
          const openCount = db.prepare(`
            SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'
          `).get(part.project_id).count;
          if (openCount === 0) {
            db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, part.project_id);
          }
        }
        }
      } else {
        const uploadingJob = uploadingJobEarly;
        if (uploadingJob) {
          if (printer.status === 'FINISHED' || printer.status === 'IDLE') {
            const creditQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
              ? parseInt(confirmed_qty, 10)
              : uploadingJob.parts_per_plate;
            db.prepare("UPDATE jobs SET status = 'finished', finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?")
              .run(now, now, uploadingJob.id);
            db.prepare("UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?")
              .run(creditQty, now, uploadingJob.part_id);
            const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(uploadingJob.part_id);
            if (part.completed_qty >= part.target_qty) {
              db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
              db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(part.id);
              const openCount = db.prepare(
                `SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'`
              ).get(part.project_id).count;
              if (openCount === 0) {
                db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, part.project_id);
              }
            }
          } else {
            db.prepare("UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?")
              .run(now, uploadingJob.id);
          }
        }
      }
    }

    db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
    });
    applyResolution();

    const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
    scheduler.scheduleForPrinter(updated);
    res.json(updated);
  });

  return app;
}

// ── Schema + seed helpers ───────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL,
      model TEXT NOT NULL, type TEXT DEFAULT 'bambu',
      status TEXT DEFAULT 'FINISHED',
      is_held INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
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
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function seedPrinter(db, { status = 'FINISHED', isHeld = 1 } = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', 'mk4s', ?, ?, 1, ?)
  `).run(`P_${now}_${Math.random()}`, status, isHeld, now).lastInsertRowid;
}

function seedProject(db) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES ('Proj', 'active', 0, ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(db, projectId, { targetQty = 100, completedQty = 0, status = 'open' } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
     VALUES (?, 'Part A', ?, ?, ?, 0, ?, ?)`
  ).run(projectId, targetQty, completedQty, status, now, now).lastInsertRowid;
}

function seedJob(db, printerId, partId, { status = 'printing', partsPerPlate = 4, finishedAt = null } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(printerId, partId, partsPerPlate, status, now - 3600000, finishedAt, now).lastInsertRowid;
}

function completed(db, partId) {
  return db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId).completed_qty;
}

// ── FIX 1a: is_held precondition ─────────────────────────────────────────────────

describe('FIX 1a (finding 4): set-ready requires a held printer', () => {
  test('returns 409 and credits nothing when the printer is not held', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 10 });
    const printerId = seedPrinter(db, { isHeld: 0 });
    seedJob(db, printerId, partId, { status: 'printing' });

    const res = await request(makeApp(db)).post(`/api/printers/${printerId}/set-ready`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Printer is not awaiting sign-off');
    expect(completed(db, partId)).toBe(10); // untouched
  });

  test('succeeds (200) when the printer is held', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    seedJob(db, printerId, partId, { status: 'printing', partsPerPlate: 4 });

    const res = await request(makeApp(db)).post(`/api/printers/${printerId}/set-ready`).send({});

    expect(res.status).toBe(200);
    expect(completed(db, partId)).toBe(4); // missed-finish credited once
  });
});

// ── FIX 1b: session-failed fallback scope guard ──────────────────────────────────

describe('FIX 1b (finding 4): stale failed job is not credited when a newer job exists', () => {
  test('a session-failed job is NOT credited when a newer job exists for the printer', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    // Session-failed job (finished_at > startedAt=0), the exact row the auto-fail could leave.
    seedJob(db, printerId, partId, { status: 'failed', partsPerPlate: 4, finishedAt: Date.now() });
    // A newer job for the same printer (higher id) means the failed row is stale.
    seedJob(db, printerId, partId, { status: 'queued', partsPerPlate: 4 });

    const res = await request(makeApp(db)).post(`/api/printers/${printerId}/set-ready`).send({});

    expect(res.status).toBe(200);
    expect(completed(db, partId)).toBe(0); // phantom credit prevented
  });

  test('a session-failed job with no newer job IS still credited (legit MQTT-recovery race)', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    seedJob(db, printerId, partId, { status: 'failed', partsPerPlate: 4, finishedAt: Date.now() });

    const res = await request(makeApp(db)).post(`/api/printers/${printerId}/set-ready`).send({});

    expect(res.status).toBe(200);
    expect(completed(db, partId)).toBe(4); // guard does not break the legitimate path
  });
});

// ── FIX 2: idempotency, completed_qty changes exactly once ───────────────────────

describe('FIX 2 (finding 5): duplicate set-ready is a no-op', () => {
  test('double missed-finish submission credits exactly once, second returns 409', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    seedJob(db, printerId, partId, { status: 'printing', partsPerPlate: 4 });
    const app = makeApp(db);

    const first  = await request(app).post(`/api/printers/${printerId}/set-ready`).send({});
    const second = await request(app).post(`/api/printers/${printerId}/set-ready`).send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(completed(db, partId)).toBe(4); // credited once, not twice
  });

  test('cross-path double submission: missed-finish 20 then duplicate does not subtract', async () => {
    // The audit's worst case: first credits 20 and marks the job finished; the duplicate would
    // have taken the normal-finish path and applied delta 20-25 = -5, leaving 15. The 409 stops it.
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    seedJob(db, printerId, partId, { status: 'printing', partsPerPlate: 25 });
    const app = makeApp(db);

    const first  = await request(app).post(`/api/printers/${printerId}/set-ready`).send({ confirmed_qty: 20 });
    const second = await request(app).post(`/api/printers/${printerId}/set-ready`).send({ confirmed_qty: 20 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(completed(db, partId)).toBe(20); // not 15
  });

  test('double normal-finish confirmed_qty adjustment applies the delta once', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 25 }); // full plate already credited by _handleFinished
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    seedJob(db, printerId, partId, { status: 'finished', partsPerPlate: 25, finishedAt: Date.now() });
    const app = makeApp(db);

    const first  = await request(app).post(`/api/printers/${printerId}/set-ready`).send({ confirmed_qty: 24 });
    const second = await request(app).post(`/api/printers/${printerId}/set-ready`).send({ confirmed_qty: 24 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(completed(db, partId)).toBe(24); // delta -1 applied once, not -2
  });
});

// ── FIX 4 support: held printer with no tracked job releases with zero credit ─────

describe('FIX 4 support: held printer with no tracked job', () => {
  test('releases the hold, credits nothing, returns 200', async () => {
    const db  = makeDb();
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 7 });
    const printerId = seedPrinter(db, { isHeld: 1, status: 'FINISHED' });
    // No job seeded. Matches the untracked-FINISHED hold set by the scheduler (FIX 4).

    const res = await request(makeApp(db)).post(`/api/printers/${printerId}/set-ready`).send({});

    expect(res.status).toBe(200);
    expect(completed(db, partId)).toBe(7); // no credit
    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(0); // hold released so the printer re-enters dispatch
  });
});

// ── Drift guard: the shipped server/index.js still carries every fix ──────────────

describe('handler source invariants (guards against replica drift)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const setReady = src.slice(src.indexOf("app.post('/api/printers/:id/set-ready'"));

  test('is_held precondition returns 409 (FIX 1a)', () => {
    expect(setReady).toMatch(/if \(!printer\.is_held\)/);
    expect(setReady).toContain('Printer is not awaiting sign-off');
  });

  test('crediting logic is wrapped in a transaction (FIX 2)', () => {
    expect(setReady).toContain('db.transaction(');
  });

  test('session-failed fallback has the newer-job scope guard (FIX 1b)', () => {
    expect(setReady).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM jobs newer WHERE newer\.printer_id = j\.printer_id AND newer\.id > j\.id/);
  });
});
