# Phase 0 Audit Findings

Date: 2026-07-12. Auditor: multi-agent review (9 subsystem auditors; every Critical and Should-fix finding independently re-verified by one or two adversarial reviewers reading the code). Scope per PLAN.md section 3a: full codebase at upstream commit a2ccb74c, read-only. Baseline: npm test green (25 suites, 391 tests) on Node 22.22.2.

Verification legend: confirmed = no reviewer could refute it against the code. disputed = one reviewer refuted or downgraded it; treat with judgment. Notes were not adversarially verified.

Totals: 6 Critical and 28 Should-fix confirmed, 1 disputed, 4 refuted (listed at the end for transparency), 33 notes.

Verbatim code excerpts in evidence blocks retain upstream punctuation, including dashes; all prose in this document is dash-free per house rules.

## Go/no-go recommendation (code side): GO, fork and keep

Judged against PLAN.md section 3c. None of the rebuild criteria are met:

- Scheduler state is not fundamentally unreliable. The dispatch lock is race-free by construction (guards and job INSERT run synchronously before the first await), the stale-status replay gate exists and holds, and completion crediting is single-fire in the tracked path. The confirmed defects are seam bugs with small, localized fixes.
- Drivers are cleanly decoupled (no DB access, canonical status contract, transport mockable). The two Elegoo Critical findings (user-stop mapped to FINISHED, which false-credits parts) live entirely in deferred-brand drivers we will not deploy; they should be reported upstream but do not gate our Bambu-only launch.
- Recovery does not require manual DB surgery for the launch scenarios; the gaps found (zombie jobs on decommissioned printers, orphaned uploading rows in the 90s grace window) have operator-visible workarounds and small fixes.
- Credentials can be secured without rewriting routes: every confirmed exposure (printer endpoints, dashboard payload, inline operator endpoints, backup export, client PrinterDetail) is a serialization/redaction problem, exactly what PR 3 already scopes.
- The team can understand the core modules (the audit itself is evidence), and the 25-suite test bed proves the code is testable.

Conditions attached to the GO:

1. PR 3 (credential redaction) must cover every leak point listed in this document, including the backup export and the two client pages, not only the printer routes.
2. The four non-driver Criticals (set-ready phantom credit, set-ready non-idempotent adjustment, stale-job auto-fail racing live uploads, plus the operator-endpoint credential leak) need a dedicated fix brief before launch; they are small but they touch part-count integrity, so they follow the completed_qty escalation rules.
3. The untracked-FINISHED auto-dispatch (Should-fix after dispute, physical-damage risk) should be fixed or mitigated operationally (rule: no phone-initiated prints on enrolled printers) before lights-out operation.
4. Final go/no-go still requires Task 0b hardware validation on X1C/P1S, P2S, H2D; this verdict covers the code only.


## Confirmed findings (36): 6 Critical, 28 Should-fix, 2 Note

### 1. [Critical] User-stopped print mapped to FINISHED, which immediately credits a full plate of parts for an aborted print

`server/drivers/elegoo-centauri.js:86` (drivers-other)

mapStatus case 3 ('Stopped - user-stopped') returns 'FINISHED'. Every other driver maps user cancel to STOPPED (klipper.js:29 `cancelled: 'STOPPED'`), which routes to scheduler._handlePrinterStopped (scheduler.js:572) - job marked 'cancelled', no inventory credit. FINISHED instead routes to _handleFinished, which credits inventory BEFORE any operator confirmation: scheduler.js:477 `UPDATE parts SET completed_qty = completed_qty + ?` runs immediately on the PRINTING→FINISHED transition; the operator hold only gates the NEXT dispatch, not the credit. Failure scenario: operator sees a failing print at 10% on a Centauri Carbon and presses Stop on the printer screen → poller sees PRINTING→FINISHED → job recorded as 'finished' and parts_per_plate good parts are credited to completed_qty; the part can even auto-close (scheduler.js:485) and cancel remaining queued jobs. The operator must remember to manually correct the count via the confirmed_qty delta path - the default flow silently corrupts inventory, the exact false-credit class documented in CLAUDE.md.

```
case 3:  return 'FINISHED'; // stopped — operator must confirm
```

### 2. [Critical] CC2 stopping/stopped sub-statuses (2503/2504) mapped to FINISHED - same false part credit as CC1

`server/drivers/elegoo-centauri2.js:61` (drivers-other)

mapPrintStatus returns 'FINISHED' for sub_status 2503 ('stopping') and 2504 ('stopped'), i.e. user-cancelled prints. As with the CC1 driver, the PRINTING→FINISHED transition fires scheduler._handleFinished, which marks the job 'finished' and immediately runs `UPDATE parts SET completed_qty = completed_qty + parts_per_plate` (scheduler.js:473-479) before the operator confirms anything. Failure scenario: a CC2 print is stopped from the printer's touchscreen mid-print (sub_status 2504) → the aborted plate is credited as fully completed good parts, potentially auto-closing the part and cancelling its remaining queued jobs. The 2503 'stopping' mapping is worse: the transition can fire while the machine is still decelerating, so even a subsequent distinct 'stopped' state can't correct it. Should map to STOPPED so _handlePrinterStopped cancels the job with no credit, matching klipper/bambu behavior.

```
if (subStatus === 2077 || subStatus === 2503 || subStatus === 2504) return 'FINISHED';
```

### 3. [Critical] Inline operator endpoints also return full printer rows with credentials

`server/index.js:337` (routes-credentials)

POST /api/printers/:id/set-ready (line 334 'SELECT * FROM printers', res.json(updated) at 337) and POST /api/printers/:id/recommission (line 143 SELECT *, res.json(updated) at 146) return the complete printer row including api_key and serial_number. These are separate from the printers router and must be covered independently by the fork's redaction PR - filtering only server/routes/printers.js leaves these two leaks. Failure scenario: same credential disclosure as the router endpoints, triggered on every operator set-ready/recommission click.

```
const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id); ... res.json(updated);
```

### 4. [Critical] set-ready has no is_held precondition and an ungated cancelled-job fallback, enabling phantom part credit

`server/index.js:249` (routes-credentials)

The endpoint never checks printer.is_held or any operator-confirmation state; it infers what to credit purely from job rows. Two concrete phantom-credit paths: (1) The cancelled-job fallback (lines 249-252) has no time gate (comment at 240-243 acknowledges this), so a months-old cancelled job is picked as activeJob and credited a full plate (lines 261-270). (2) If a job is mid-upload (status 'uploading', printer still IDLE - the normal DB state during every dispatch), lines 296-307 mark the in-flight job 'finished' and credit the full plate before anything has printed. Failure scenario: printer is held FINISHED; operator A releases it via set-ready-batch and the scheduler dispatches a new job (uploading); operator B's stale Fleet tab still shows the printer as held and B clicks Set Ready - the request credits either an old cancelled job or the in-flight upload, inflating completed_qty, potentially closing the part and cancelling its queued jobs (line 278), i.e. duplicate credit plus lost queued work. The endpoint is also fully repeatable - nothing marks a confirmation as consumed.

```
|| db.prepare(`
            SELECT * FROM jobs WHERE printer_id = ? AND status = 'cancelled'
            ORDER BY finished_at DESC LIMIT 1
          `).get(printer.id);
```

### 5. [Critical] set-ready confirmed_qty adjustment is not idempotent - duplicate requests corrupt completed_qty

`server/index.js:208` (routes-credentials) | originally rated Should-fix, adjusted in verification

The normal-finish path applies delta = confirmed_qty - parts_per_plate against the part every time it runs, with no marker that the finished job was already adjusted. Failure scenario: plate of 25, operator confirms 24 good; a double-click or client retry sends the request twice; each request subtracts 1, leaving completed_qty 2 short. Worse across paths: a missed-finish confirmation of 20/25 credits 20 and marks the job finished; the duplicate request then takes the normal path and applies delta 20-25 = -5, so the part ends at 15 instead of 20, and every further retry subtracts 5 more.

```
const delta = confirmedQty - finishedJob.parts_per_plate; // negative = fewer good parts
          db.prepare(`
            UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?
```

Reviewer DOWNGRADE: Verified against server/index.js lines 161-338 and the jobs schema in server/db.js. The claim holds.

Confirmed mechanics:
- The jobs table (server/db.js CREATE TABLE jobs, line 68) has no column marking a finished job as "confirmed_qty already applied" (no confirmed_at, no adjustment flag). Status stays 'finished' indefinitely until a new job is created for that printer.
- In the normal-finish branch (index.js lines 203-222), every invocation that finds the same `finishedJob` row recomputes `delta = confirmedQty - finishedJob.parts_per_plate` and applies it unconditionally via `UPDATE parts SET completed_qty = MAX(0, completed_qty + ?)`. Nothing changes finishedJob's identity or status after the delta is applied, so a second identical request finds the exact same row and reapplies the same delta. Plate of 25, confirm 24 (delta -1), sent twice, yields -2 total: confirmed math checks out.
- The missed-finish-then-duplicate cross-path scenario also checks out: first call finds the job in 'printing' status (finishedJob query returns null because printingJobEarly is truthy), takes the missed-finish branch (line 223+), sets status='finished' and credits creditQty=20 directly (line 265-270). A duplicate request now finds that same job via the finishedJob query (line 186-189, now status='finished', no newer cancelled job to null it out), takes the normal-case branch, and applies delta = 20 - 25 = -5. Net: +20 then -5 = +15, matching the auditor's arithmetic exactly.
- No idempotency key, no request de-duplication, no job-side "already adjusted" marker anywhere in this handler or the jobs schema.

Reachability: client/src/pages/Fleet.jsx `setReady()` (line 383-396) has no disabled/in-flight guard on the button before the fetch resolves and no debounce - PrinterCard's onClick (Fleet.jsx line 234, 258, 283) calls onSetReady directly with no loading state, so an operator double-click or a browser/network retry is trivially able to fire two POSTs before the first one's response causes a re-render. Because better-sqlite3 is synchronous and Node is single-threaded, the two requests are not even a race - they are serialized and both apply deterministically, which makes this easier to trigger than a typical concurrency bug, not harder.

Severity: I'm marking this DOWNGRADE-to-Critical (direction: the auditor under-rated it), not because the reasoning is wrong but because this is a direct, deterministic violation of CLAUDE.md's non-negotiable #1 ("Part counts are sacred... any code path that changes completed_qty must be... impossible to double-fire") and matches the spirit of the repo's own named mistake "the phantom part credit." It requires no unusual timing, no restart, no reconnect - just an operator double-clicking Set Ready, which is a completely ordinary UI interaction with no client-side guard against it. Silent, deterministic corruption of a sacred data field from a common user action warrants Critical rather than Should-fix.

### 6. [Critical] Stale-job auto-fail runs before the in-flight-upload guard and can kill a live upload, then a later Set Ready can credit the phantom job

`server/scheduler.js:221` (scheduler) | originally rated Should-fix, adjusted in verification

_dispatchToPrinter checks the active-job/stale-job logic (lines 204-235) BEFORE the _activeUploads in-flight guard (line 240). An upload cycle routinely exceeds STALE_JOB_GRACE_MS=90s: the 409 UPLOAD_CONFLICT retry waits 60s (line 381) and klipper.js allows 5-minute transfers (timeout: 300000), and _waitForBatch's own comment says large files take several minutes. Scenario: printer A's upload is on its 60s conflict wait (job 'uploading', started_at null, jobAge>90s, printer status still IDLE); the operator activates a project or hits /api/scheduler/dispatch; the sweep calls _dispatchToPrinter for A; isStaleEligible is true (status IDLE) and jobAge>90000, so the LIVE job is marked 'failed' with finished_at=now and the printer is held with a false 'stale job automatically cancelled' notification. If the in-flight upload then succeeds, line 419 unconditionally flips the 'failed' row back to 'printing' on a now-held printer; if it fails, line 415 leaves a job that is 'failed' (not 'uploading' as the operator resolution flow expects), and because finished_at > scheduler.startedAt, the set-ready session-failed fallback (server/index.js:246-248) will credit its full parts_per_plate if the operator clicks Set Ready - a phantom part credit for a print that never happened. Fix is ordering: consult _activeUploads before the stale-job auto-fail.

```
if (isStaleEligible && jobAge > STALE_JOB_GRACE_MS) {
  this.db.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?")
    .run(Date.now(), activeJob.id);
  this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
```

Reviewer DOWNGRADE: Verified against the actual code and the finding holds; if anything it is under-rated given this codebase's own stated priorities.

Ordering is exactly as claimed: activeJob/stale-job check (scheduler.js:204-235) runs before the _activeUploads in-flight guard (line 240), and STALE_JOB_GRACE_MS is 90s (line 15) while a real upload cycle (5-min Klipper transfer per driver.js timeout, 60s conflict-retry wait at line 381, _waitForBatch's own comment about multi-minute large-file transfers) routinely exceeds that.

The auditor's proposed trigger ("operator activates a project or hits /api/scheduler/dispatch") is actually blocked: every one of those paths (sweepIdlePrinters, scheduleForPrinter) routes through _sweepInBatches, which is guarded synchronously by this._isSweeping (set true before any await) and defers same-printer re-dispatch to _pendingPrinters, processed only after _waitForBatch confirms the in-flight job settled. So that specific trigger phrase is wrong.

However, there is a second, unguarded path the auditor missed but which independently reproduces the same bug: poller.js's `printerIdle` event handler (scheduler.js:36-40) calls `_dispatchToPrinter` directly, bypassing `_isSweeping` entirely. `printerIdle` fires whenever a poll transitions status into IDLE from something else (poller.js:102-104). Per driver-authoring.md convention, `getStatus` returns OFFLINE on any error/~8s timeout - plausible when a poll races a long-running upload/transfer and times out. A poll sequence of IDLE(upload starts) -> OFFLINE(transient poll timeout mid-transfer) -> IDLE(next poll, transfer still ongoing) emits `printerIdle` directly into `_dispatchToPrinter` for a printer whose real upload is still in flight and already older than 90s. This hits the stale-job branch (line 221) before `_activeUploads` is even consulted (line 240), marking the live job 'failed' and holding the printer while the original upload attempt is still running.

The downstream consequences the auditor describes are real: if the racing original upload later succeeds, line 419-421 unconditionally overwrites the job (now 'failed') back to 'printing' with no status check, leaving is_held=1 permanently mismatched with a 'printing' job. If it fails instead, the job is left 'failed' with finished_at set within the current session (verified in index.js:244-248, the exact fallback cited), and finished_at > scheduler.startedAt, so a subsequent Set Ready click at index.js:261-270 credits `activeJob.parts_per_plate` to `parts.completed_qty` for a print that never actually printed - a genuine phantom part credit, which CLAUDE.md's own non-negotiable #1 and the named "phantom part credit" mistake identify as the single most dangerous class of bug in this codebase.

Because the reachable failure mode is a real, race-condition path to double/phantom-crediting completed_qty (not merely a UX or ordering nit), and the project's own escalation rules treat any completed_qty risk as requiring the highest scrutiny, this should be rated Critical rather than Should-fix, even though the auditor's specific cited trigger (project activation / manual dispatch endpoint) is incorrect and the real trigger is the unguarded poller.printerIdle listener.

### 7. [Should-fix] Printer API key / Bambu access code fetched, rendered in cleartext, and round-tripped by the detail edit form

`client/src/pages/PrinterDetail.jsx:186` (client-leak) | originally rated Critical, adjusted in verification

The printer detail page expects GET /api/printers/:id to include the raw credential (`printer.api_key`, line 186) and renders it in a plain text input (lines 352-361, type="text", not password), so anyone who can open the unauthenticated UI on the LAN can read every printer's PrusaLink API key or Bambu/Elegoo access code just by clicking Edit. It also unconditionally sends `api_key: detailsDraft.api_key.trim()` on every save (line 213), even when the user only changed the IP or group. Failure scenario for the redaction PR: if the server starts redacting/masking api_key in the GET response without changing this page, the edit form pre-fills with the masked value and the very next detail save overwrites the real credential in the DB with the mask, silently breaking connectivity to that printer. The redaction PR must make this form treat api_key as write-only (blank field = unchanged).

```
api_key: printer.api_key || '',  ...  <input value={detailsDraft.api_key} ... />  ...  body: JSON.stringify({ ip, api_key: detailsDraft.api_key.trim(), ...
```

Reviewer DOWNGRADE: All raw facts check out: GET /api/printers/:id returns api_key via SELECT * (printers.js:116); startEditDetails pre-fills it (PrinterDetail.jsx:185); the API Key input has no type attribute so it renders as cleartext text (lines 355-360); and submitEditDetails always sends api_key (line 213), applied via COALESCE(?, api_key) in the PUT (printers.js:191). However, the cited failure scenario - the edit form pre-filling a masked value and silently overwriting the real DB credential - is explicitly conditional on a redaction change that does not exist in this tree ("if the server starts redacting..."). In the current code GET returns the real key, so the form round-trips it losslessly and there is NO present data-loss bug; the save path writes back exactly what it read. So as a standalone correctness defect the described failure is not reachable against the actual control flow. What is real today is credential exposure in the UI, but this is a LAN, single-tenant, unauthenticated farm manager where any UI user already has full destructive control (decommission, delete, mark-failure); exposing a LAN device key to an already-fully-privileged local operator is a hardening gap, not a Critical correctness bug, and produces no wrong output on its own. The finding is a valid and useful prerequisite note for a future redaction PR (make the form write-only, blank = unchanged), but the Critical rating and the data-overwrite failure scenario overstate the current code. Downgrading to Should-fix.

### 8. [Should-fix] Restore writes gcode files to disk before the DB transaction; a failed restore leaves files overwritten while the DB rolls back

`server/routes/backup.js:136` (db-backup)

gcode_files are written into GCODE_DIR (lines 136-138) before restore() runs. If the transaction then throws - e.g. a NOT NULL or FK violation because a column is present in some backup rows but not others (makeInserter binds missing values as NULL, line 57, which violates NOT NULL columns like parts.sort_order when rows are heterogeneous) - better-sqlite3 rolls the DB back and the route 500s, but the gcode files are not rolled back. Any uploaded file sharing a basename with a live gcode has silently replaced its content, so the still-intact pre-restore jobs/parts now dispatch different gcode bytes under the same filename to physical printers. Files should be staged and swapped in only after the transaction commits.

```
for (const [basename, b64] of gcodeEntries) {
        fs.writeFileSync(path.join(GCODE_DIR, basename), Buffer.from(b64, 'base64'));
      }
```

### 9. [Should-fix] filament_colors rebuild can silently leave foreign_keys=OFF for the whole process, or leave the table dropped

`server/db.js:174` (db-backup)

The rebuild is a multi-statement db.exec (not a transaction) starting with PRAGMA foreign_keys = OFF, inside a catch(_){} block. db.exec stops at the first failing statement: if CREATE TABLE filament_colors_new fails (e.g. a stray filament_colors_new left by a prior crash) or DROP/ALTER fails (I/O error, external lock), the exception is swallowed at line 189 and the trailing PRAGMA foreign_keys = ON never runs - the server then operates its entire lifetime with FK enforcement disabled on every table (jobs, parts, gcodes), silently permitting orphaned rows the rest of the code assumes cannot exist. A failure after DROP TABLE additionally leaves no filament_colors table at all, with no log. The jobs rebuild below avoids the silent-FK-off variant only because it is unguarded and crashes instead.

```
db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE filament_colors_new (
 ... 
      DROP TABLE filament_colors;
      ALTER TABLE filament_colors_new RENAME TO filament_colors;
      PRAGMA foreign_keys = ON;
    `);
```

### 10. [Should-fix] jobs table rebuild is non-transactional and unguarded - a partial failure causes a permanent startup crash loop

`server/db.js:203` (db-backup)

The gcode_id-nullable migration runs a multi-statement db.exec with no surrounding transaction and no try/catch, and it executes on every install where jobs.gcode_id is still NOT NULL (including first boot of a fresh DB, since the CREATE at line 72 declares NOT NULL). If any statement after CREATE TABLE jobs_migrated fails - disk full during INSERT...SELECT, or a column-count mismatch since `INSERT INTO jobs_migrated SELECT * FROM jobs` assumes jobs has exactly these 9 columns in this order (any future ALTER TABLE jobs ADD COLUMN migration placed above this block breaks it) - the process crashes at require('./db') with jobs_migrated left behind and jobs.gcode_id still NOT NULL. Every subsequent boot re-enters the branch and `CREATE TABLE jobs_migrated` throws 'table already exists': the server cannot start until someone manually drops jobs_migrated. It may also leave foreign_keys OFF mid-exec, though the crash makes that moot.

```
db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE jobs_migrated (
 ... 
    INSERT INTO jobs_migrated SELECT * FROM jobs;
    DROP TABLE jobs;
```

### 11. [Should-fix] update.bat masks npm install failures - success check only tests node_modules existence

`update.bat:29` (deploy-ci)

Both install steps validate success with `if not exist node_modules`, but on any machine that has run the script before, node_modules already exists, so a failed `npm install` (registry outage, better-sqlite3 native compile failure under Node 22, or a failed patch-package postinstall meaning the sdcp patch was NOT applied) passes the check. The script then proceeds to build and restart the server, mixing freshly git-pulled code with stale or partially-updated dependencies - e.g. new server code calling into an old module version, or the unpatched sdcp dumping printer objects to the console. Errorlevel of `call npm install` is never checked (same pattern at line 40-47 for the client).

```
call npm install
if not exist node_modules (
```

### 12. [Should-fix] Port-3000 kill loop matches netstat foreign-address column and can taskkill /F unrelated processes

`update.bat:62` (deploy-ci)

`netstat -aon | findstr /R ":3000 "` matches any line containing ":3000 " in EITHER the local or foreign address column. If the operator has the dashboard open in a browser during an update, the ESTABLISHED client-side connection lines (foreign address ...:3000) carry the browser's PID in token 5, and the loop force-kills it (taskkill /F) along with the server. Any other process with an outbound connection to some host's port 3000 is killed too. TIME_WAIT lines yield PID 0 (harmless failure), and UDP lines have only 4 tokens, making %%a the state/PID column mismatch. On a farm machine this means a routine update can hard-kill the operator's browser or other tooling without warning.

```
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R ":3000 "') do (
    taskkill /F /PID %%a 2>nul
```

### 13. [Should-fix] Runtime container runs as root - no USER directive

`Dockerfile:45` (deploy-ci)

The runtime stage never drops privileges (no USER node), so the Express process - which has zero authentication, accepts multipart gcode uploads, and writes to mounted volumes - runs as uid 0 inside the container. Any file-write or path-handling bug elsewhere in the server escalates to root-owned writes across the container filesystem and both volumes, and files created in farm-data/farm-gcode volumes are root-owned on the host. The base image ships a `node` user ready to use; adding auth in the fork does not mitigate a root-process compromise. Failure scenario: a path-traversal or upload bug in the API yields arbitrary root file write in the container instead of being contained to an unprivileged user.

```
EXPOSE 3000

CMD ["node", "server/index.js"]
```

### 14. [Should-fix] uploadAndPrint resolves successfully even if the MQTT print command is never delivered - silent no-start sticks the job in 'printing'

`server/drivers/bambu.js:320` (driver-bambu)

The project_file publish is fire-and-forget: the callback only logs errors, and the async function resolves before/regardless of the callback. The scheduler (scheduler.js:418-420) then marks the job 'printing'. conn.connected is checked at line 287, but that flag can be stale for up to the MQTT keepalive interval (~60s) if the printer dies between the FTPS upload completing and the publish - the QoS-0 packet is written to a dead socket with no error, or (with mqtt.js default queueQoSZero) queued and delivered minutes later, starting a print at an unexpected time. There is also no verification that the firmware accepted the command (no check of the report topic result), so a firmware rejection (e.g. the .3mf case in the plate_1 finding below) also leaves the job 'printing'. Failure scenario: publish is lost → printer stays IDLE → poller sees no status transition, so no printerIdle event ever fires, no dispatch runs, and the stale-job auto-fail in _dispatchToPrinter (scheduler.js:204-235) is never triggered - job and printer stuck indefinitely with no notification. This is the same class as the documented 'silent Moonraker no-op' bug.

```
conn.client.publish(`device/${printer.serial_number}/request`, mqttPayload, (err) => {
    if (err) console.error(`[bambu] MQTT publish failed for ${printer.name}:`, err.message);
    else console.log(`[bambu] MQTT publish confirmed for ${printer.name}`);
  });
```

### 15. [Should-fix] MQTT connection cache is never invalidated: dropConnection is dead code (not exported, never called), so IP/access-code changes, decommission, and delete leak stale connections

`server/drivers/bambu.js:39` (driver-bambu)

getOrCreateConnection returns the cached connection keyed by printer.id without comparing printer.ip/api_key/serial_number, and dropConnection (line 104) is absent from module.exports (line 385) and has zero call sites anywhere in the repo. PUT /api/printers/:id (routes/printers.js:150-201) updates ip/api_key/serial in the DB, but the driver keeps using the MQTT client built from the old values until a full server restart. Failure scenarios: (a) operator corrects a mistyped access code - the printer stays OFFLINE forever despite correct DB values, with no hint why; (b) DHCP reassigns IPs between two Bambu printers and the operator updates the rows - the cached client still targets the old IP, so getStatus serves no/stale data and cancelJob publishes into the wrong machine's broker (silently ignored); (c) POST /:id/decommission (routes/printers.js:231) and DELETE /:id (routes/printers.js:227) leave the client reconnecting to the device every 5 s forever - an unbounded resource leak across the fleet's lifetime, still authenticating with a credential the farm no longer manages.

```
if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }
```

### 16. [Should-fix] SDCP driver getStatus can hang forever, permanently blocking pollComplete and startup dispatch for the whole farm

`server/drivers/elegoo-centauri.js:45` (drivers-other) | originally rated Critical, adjusted in verification

getStatus breaks the never-hang contract: no SDCP operation has a timeout. `await client.Connect(printer.ip)` (line 45) never settles for an unreachable printer because AutoReconnect is set first (line 31) - sdcp's 'close' handler (node_modules/sdcp/SDCPPrinterWS.js ~line 233) only retries and invokes the callback exclusively on success (`if (!err && Callback)`), never rejecting. GetStatus/SendCommand likewise push a request and wait for a websocket reply with no deadline (SDCPPrinterWS.js SendCommand). Failure scenario: one CC1 printer is off, mis-IP'd, or unresponsive at server start. getStatus's promise never settles, so poller.js:38 `Promise.allSettled` never resolves for any tick, `pollComplete` never fires, and index.js:101 `poller.once('pollComplete', () => scheduler.sweepIdlePrinters())` never runs - no jobs dispatch to ANY printer after restart until someone manually hits /api/scheduler/dispatch. Additionally, because `connections.set` runs only after Connect resolves, every 15 s tick constructs a fresh auto-reconnecting SDCPPrinterWS (unbounded socket/timer/promise leak), and a hung SendCommand inside uploadAndPrint stalls the batched sweep (scheduler waits for each batch) indefinitely with no retry-loop escape.

```
client.AutoReconnect = 5000; ... await client.Connect(printer.ip); connections.set(printer.id, client);
```

Reviewer DOWNGRADE: The core technical claim is verified true by reading the code:

1. server/drivers/elegoo-centauri.js:31/45 - `client.AutoReconnect = 5000` is set before `await client.Connect(printer.ip)`.
2. node_modules/sdcp/SDCPPrinterWS.js Connect(): on failure the socket emits 'error' then 'close'. The 'error' handler only calls Callback (which rejects the wrapping promise) `if (this.#_AutoReconnect === false` - false here since AutoReconnect is truthy. The 'close' handler (line 234-247) instead schedules a `setTimeout` retry and recurses into `Connect(MainboardIP, (err) => { if (!err && Callback) Callback.call(Printer); Callback = undefined; })` - the original Callback is only invoked on a *successful* reconnect, never on continued failure. So for an unreachable/off/mis-IP'd printer, `client.Connect()`'s promise genuinely never settles (neither resolves nor rejects), confirming the "never-hang contract" violation exactly as claimed.
3. getStatus's try/catch (elegoo-centauri.js:135-138) never runs in this case since nothing rejects - getStatus hangs forever, matching the claim.
4. poller.js:38 `Promise.allSettled` requires every entry to settle; one perpetually-pending promise means it never resolves, so `pollComplete` (line 48) never fires for that tick - confirmed against poller.js and index.js:101's `poller.once('pollComplete', ...)`.
5. However, per-printer `statusChange`/`printerIdle` events (poller.js:100/103) fire synchronously inside `_pollPrinter` as each individual printer's own poll resolves, independent of the overall `Promise.allSettled`. Scheduler's continuous dispatch path (scheduler.js:36-58, driven by these two events) is therefore NOT frozen for the rest of the farm on an ongoing basis - only the one-shot `poller.once('pollComplete', ...)` sweep that runs once at server startup (index.js:101-104) is blocked. That is a real gap ("dispatch doesn't auto-resume after a restart if one Elegoo printer is unreachable, until someone hits `/api/scheduler/dispatch`"), narrower than "no jobs dispatch to ANY printer after restart" reads literally, but still a genuine farm-wide effect at every restart.
6. The batched-sweep claim is also verified and actually broader than described: `_sweepInBatches` (scheduler.js:110-117) uses `Promise.all` over a batch with per-call `.catch()`, but if the broken printer is dispatched to (its status can get stuck at a stale IDLE/FINISHED value forever since its own poll never completes to update it) and `uploadAndPrint`'s `SendCommand`/`getConnection` hangs the same way, the whole `Promise.all` for that batch never settles, stalling every other printer in that batch and all subsequent batches of that sweep - not just future polls.
7. The connection-leak claim is also correct: `connections.set()` (line 46) never runs for the unreachable printer, so each 15 s tick's `getConnection` builds a brand-new auto-reconnecting `SDCPPrinterWS` (new socket, new internal setTimeout retry loop) that itself never gets cleaned up, an unbounded per-tick resource leak.

So the finding is real, not a false positive, and the mechanism is correctly traced through both this repo and the vendored `sdcp` package. Where it is over-rated: this task's IMPACT rubric defines Critical as job loss/duplication, part double-credit, credential exposure, path traversal, or data corruption. This bug produces none of those - no `parts.completed_qty` path is touched, no credentials leak, no data is corrupted or lost; a stuck job just sits in an ambiguous uploading/dispatch state until manual intervention (`POST /api/scheduler/dispatch`) or a server restart with the offending printer removed/reachable. It is a severe availability/DoS-style reliability bug (worse than a first read suggests, since it can stall entire dispatch batches, not just the initial startup sweep) but it does not meet the stated Critical bar for this repo's review lens. Should-fix is the correct rating: fix by adding a timeout race (e.g. `Promise.race` with a deadline) around `Connect`/`GetStatus`/`SendCommand` per the driver contract's "getStatus never throws, ~8s timeouts" rule already spelled out in CLAUDE.md's driver conventions.

### 17. [Should-fix] dropConnection cannot actually kill an sdcp client (AutoReconnect zombie) and getConnection races under concurrency

`server/drivers/elegoo-centauri.js:52` (drivers-other)

Two lifecycle defects in the connection Map. (1) dropConnection calls `client.Disconnect?.()`, but sdcp's Disconnect just closes the websocket; the 'close' handler then sees AutoReconnect !== false and schedules Printer.Connect again forever (SDCPPrinterWS.js close handler) - Disconnect never clears AutoReconnect. So every getStatus failure (line 136 calls dropConnection) leaves a zombie client reconnecting to the printer every 5 s for the life of the process while the driver builds a new one next tick; over days this accumulates sockets, timers, and duplicate live connections to the same printer. (2) getConnection has a check-then-set race across `await client.Connect(...)`: a poll tick and an uploadAndPrint (or two overlapping ticks, since poller ticks are not serialized) both see `connections.has(printer.id)` false, both connect, and the second `connections.set` overwrites the first - the loser is never disconnected and auto-reconnects forever.

```
function dropConnection(printerId) {
  const client = connections.get(printerId);
  if (client) {
    try { client.Disconnect?.(); } catch (_) {}
```

### 18. [Should-fix] Every printer REST endpoint returns api_key (Bambu LAN access code) and serial_number unredacted

`server/routes/printers.js:64` (routes-credentials) | originally rated Critical, adjusted in verification

All printer-row responses use SELECT * / SELECT p.* with no column filtering, so api_key and serial_number round-trip to any client. Per drivers/bambu.js:12-13,49,273 api_key is the Bambu LAN access code (MQTT+FTP password) and serial_number is the MQTT topic key; for Prusa it is the PrusaLink API key. Leaking endpoints in this file: GET /api/printers (line 41 SELECT p.*, res.json at 64), GET /api/printers/decommissioned (93-94), GET /api/printers/:id (116-118), POST /api/printers 201 body (141), PUT /api/printers/:id (214), POST /:id/decommission (239), POST /:id/complete-and-decommission (320), POST /:id/link-job (553). Failure scenario: any browser on the LAN loads the Fleet page (or curls GET /api/printers) and obtains every printer's access code and serial, enabling direct MQTT/FTP control of the printers that bypasses the farm manager entirely. This is the exhaustive redaction list for this file.

```
SELECT p.*, ... FROM printers p WHERE p.is_active = 1 ... res.json(printers);
```

Reviewer DOWNGRADE: The code claim is accurate and the scenario is reachable: every listed handler returns raw printer rows via SELECT * / SELECT p.* with res.json and no redaction, and server/index.js has no authentication whatsoever (grep for auth/password/session/login/token/bearer returns only unrelated comments), so any LAN client hitting port 3000 obtains api_key and serial_number. I do not refute it. But Critical is over-rated for two reasons. (1) The app is unauthenticated by design; an attacker on the LAN already has full printer control through this file's own open endpoints (scheduler dispatch, cancel, POST /:id/decommission, DELETE /:id at line 224). The access-code leak only adds out-of-band MQTT/FTP control bypassing the manager, an incremental hardening gap rather than a new capability, whereas the claim frames the leak as the crux. (2) The exposure is partly load-bearing: client/src/pages/PrinterDetail.jsx:185 reads printer.api_key from the GET /:id response to pre-fill the edit form, so the prescribed blanket redaction is not a clean drop-in and GET /:id returning api_key is current design. This repo reserves Critical for part-count/hardware-damage classes; a reachable credential exposure in an already-unauthenticated LAN tool where the client consumes the field is Should-fix hardening.

### 19. [Should-fix] set-ready-batch releases holds with none of the single set-ready crediting logic - missed-finish jobs get auto-failed with zero credit

`server/index.js:121` (routes-credentials)

The batch endpoint just clears is_held for all ids and sweeps; it skips the entire missed-finish/cancelled/upload-stalled resolution that POST /:id/set-ready performs. For a printer whose job is still 'printing' because the server was down at FINISHED, the sweep's _dispatchToPrinter (scheduler.js:220-228) sees a printing job on a non-PRINTING printer, auto-fails it without crediting completed_qty, and re-holds the printer. Failure scenario: server down overnight, 15 printers finish their plates (jobs stuck 'printing'); operator selects all and clicks 'Set Ready (15)'; all 15 completed plates are marked failed with no inventory credit, and each printer re-holds. Recovery requires the operator to notice and individually re-confirm each printer (the failed-job fallback at index.js:246-248 does allow it), but nothing tells them credit was withheld beyond a notification per printer. Also, the UPDATE has no is_active filter, so decommissioned printers in ids get their hold silently cleared.

```
db.prepare(`UPDATE printers SET is_held = 0 WHERE id IN (${placeholders})`).run(...ids);
```

### 20. [Should-fix] Recommission dispatches immediately on frozen stale status with no fresh poll

`server/index.js:145` (routes-credentials)

The poller only polls is_active = 1 printers (poller.js:33), so a decommissioned printer's status column is frozen at its value from decommission time. Recommission flips is_active/is_held and calls scheduler.scheduleForPrinter(updated) synchronously; _dispatchToPrinter has no printer-status gate before uploading (it only checks is_held and existing job rows, scheduler.js:187-243). Failure scenario: printer decommissioned while IDLE; a technician runs a test/calibration print from the printer's own screen; operator clicks Recommission in the UI; the scheduler immediately uploads and starts a farm job on the physically busy printer. The codebase treats exactly this stale-status hazard as real at startup - index.js:98-104 gates the initial sweep on a completed poll - but recommission has no equivalent gate.

```
console.log(`[server] ${printer.name} recommissioned — dispatching...`);
    scheduler.scheduleForPrinter(updated);
```

### 21. [Should-fix] DELETE /api/printers/:id throws a 500 for any printer with job history

`server/routes/printers.js:227` (routes-credentials)

jobs.printer_id REFERENCES printers(id) with no ON DELETE action and foreign_keys = ON (db.js:19,71), so SQLite raises SQLITE_CONSTRAINT_FOREIGNKEY on delete when any job row references the printer. The route has no try/catch and no dependent-row handling, so the synchronous throw becomes an unhandled Express 500. Failure scenario: operator deletes any printer that ever ran a job - the request 500s with a raw error page and the printer cannot be removed through the UI; only printers with zero history are deletable.

```
db.prepare('DELETE FROM printers WHERE id = ?').run(req.params.id);
```

### 22. [Should-fix] CSV import uses multer memoryStorage with no file size limit

`server/routes/printers.js:8` (routes-credentials)

The multer instance sets no limits, so POST /api/printers/import buffers an arbitrarily large upload entirely in RAM (req.file.buffer) and then copies it again via toString('utf-8') at line 440. This is the only unbounded request body in the app (express.json keeps its 100kb default). Failure scenario: with no auth, anyone on the LAN posts a multi-GB 'CSV' and OOM-kills the Node process, which - combined with the missed-finish behavior elsewhere - also strands in-flight job state. An auth layer helps, but the operator can trigger it accidentally too by uploading the wrong file.

```
const upload = multer({ storage: multer.memoryStorage() });
```

### 23. [Should-fix] Dashboard response leaks printer api_key (and IP/serial) to every client

`server/routes/dashboard.js:18` (routes-files) | originally rated Critical, adjusted in verification

The dashboard endpoint selects all printer columns and returns them verbatim. The printers table contains api_key TEXT NOT NULL (server/db.js:26 - the PrusaLink API key / Bambu access code) plus ip and serial_number. Any client that loads the TV dashboard receives every printer's credentials in the JSON payload (visible in browser dev tools, proxies, logs). Failure scenario: anyone on the LAN opens /api/dashboard and harvests access codes for every physical printer, gaining direct control of the machines independent of this app. This is exactly the credential-exposure class the fork's auth work cannot fix by itself - even after PR 2 adds auth, any user allowed to view the dashboard still receives raw credentials; the response needs column filtering.

```
SELECT p.*,
  (SELECT j.parts_per_plate FROM jobs j ...
```

Reviewer DOWNGRADE: The leak is real and reachable: dashboard.js:18 runs SELECT p.* over the printers table and returns the rows verbatim in res.json (lines 17-27, 119-129) with no projection and no auth gate. The printers table holds api_key TEXT NOT NULL (db.js:26), ip (db.js:25), and serial_number (ALTER at db.js:97), so any client hitting /api/dashboard receives all of them. Not REFUTED. However Critical is overstated and the scoping is wrong: (1) this is the app-wide serialization convention, not a dashboard-specific defect - GET /api/printers uses the identical SELECT p.* (printers.js:42), the decommissioned list uses SELECT * (printers.js:93), and every single-printer handler is SELECT * FROM printers (printers.js:116,141,214,239,320); filtering only dashboard.js line 18 leaves api_key flowing out of all those endpoints, so pinning the fix here is misleading. (2) The client legitimately consumes api_key - the printers PUT handler accepts it (printers.js:155,191) for the management UI - so returning it is partly by design and the real fix is context-scoped response shaping, not a one-line patch. (3) Under the correctness lens the code returns exactly what it queries: no wrong computation, no double-credit, no hardware misfire; it is info-disclosure, and combined with the trusted-LAN deployment and the fork's own auth work (PR 2) as the actual mitigation, Should-fix is the honest rating.

Reviewer DOWNGRADE: The code is read correctly: dashboard.js:18 does `SELECT p.*` and ships api_key/ip/serial_number in the JSON response. But this is not a defect isolated to dashboard.js - it is the app's pervasive existing pattern. server/routes/printers.js does identical `SELECT p.*` on GET /api/printers, GET /api/printers/:id, and the create/update/CSV endpoints, and client/src/pages/Settings.jsx and PrinterDetail.jsx actively consume printer.api_key from those responses to power the credential-edit UI - this is intentional, not oversight. There is also currently no authentication anywhere in the app (server/index.js has no auth/session middleware), so every printer-returning route, not just the dashboard, is equally exposed to any LAN client today. The claim itself concedes the fix belongs to a broader column-filtering/authorization strategy applied after auth lands, which is a legitimate should-fix for the auth PR's scope, but rating a single file/line as Critical misattributes an app-wide, pre-existing design characteristic to one endpoint, and patching only dashboard.js would not meaningfully reduce the described blast radius since /api/printers grants the same access. Downgraded to Should-fix: track as a response-shaping/column-allowlist task to do alongside the auth work, not as a critical vulnerability unique to this file.

### 24. [Should-fix] allowed_groups stored without JSON validation; malformed value stalls all dispatch for that printer model

`server/routes/gcodes.js:154` (routes-files)

Upload (line 154) and PUT /:id (line 210: `'allowed_groups' in req.body ? (req.body.allowed_groups || null) : ...`) store the client string as-is, never validating it is a JSON array. The scheduler's candidate query uses `EXISTS (SELECT 1 FROM json_each(gcodes.allowed_groups) ...)` (server/scheduler.js:289-291); SQLite's json_each raises 'malformed JSON' at runtime when it scans a bad row, so the whole candidate SELECT throws and _dispatchToPrinter fails for EVERY printer of that model on every sweep - jobs silently stop dispatching (errors only in server log). parts.js:72 `JSON.parse(gc.allowed_groups)` likewise turns GET /api/parts/:id/dispatch-status into a 500, killing the very diagnostic an operator would use. Failure scenario: a curl user or UI bug sends allowed_groups="MK4S Farm" (plain string, not '["MK4S Farm"]') for a popular part; all MK4S printers sit idle indefinitely with no visible reason. Workaround: fix the row by hand.

```
const parsedAllowedGroups = allowed_groups && allowed_groups !== '' ? allowed_groups : null;
```

### 25. [Should-fix] Force-complete's cancellation of 'uploading' jobs is silently reverted by the scheduler

`server/routes/projects.js:122` (routes-files)

POST /:id/complete flips uploading jobs to 'cancelled' and reports them cancelled. But the scheduler's dispatch path, after the awaited upload succeeds, runs `UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?` unconditionally (server/scheduler.js:419-421) without re-checking that the job is still 'uploading'. Failure scenario: operator force-completes a project while a job is mid-upload; the API responds 'cancelled_jobs: 1', the upload then finishes, the printer physically starts printing, and the job row flips cancelled -> printing. When the print FINISHES, _handleFinished credits completed_qty onto the now-closed part of the completed project. The route also sends no stop command to the printer, so the 'cancel' has no physical effect either. Net result: DB state contradicts what the operator was told, and inventory is credited on a closed part.

```
`UPDATE jobs SET status = 'cancelled' WHERE part_id IN (${placeholders}) AND status IN ('queued', 'uploading')`
```

### 26. [Should-fix] Project duplicate drops allowed_groups / required_material / required_color from copied G-codes

`server/routes/projects.js:226` (routes-files)

The duplicate route's gcode INSERT lists only part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, created_at - the three dispatch-constraint columns are silently omitted and default to NULL. In the scheduler's candidate query NULL means 'no restriction' (scheduler.js:289-293). Failure scenario: source project's gcode is restricted to required_material='PETG', required_color='Black', allowed_groups='["XL Farm"]'; operator duplicates the project for a repeat run and activates it; the scheduler dispatches the copy to any printer of that model regardless of loaded filament or group, producing whole plates in the wrong material with no warning.

```
INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                    est_print_secs, material_grams, ams_slot, created_at)
```

### 27. [Should-fix] Upload endpoint has no size limit and no file-type restriction

`server/routes/gcodes.js:13` (routes-files)

multer is constructed with only a storage option - no `limits` (default fileSize is Infinity) and no fileFilter, and the route does not check the extension. Failure scenario: any client on the network (the app has no auth) POSTs repeated multi-gigabyte bodies to /api/gcodes/upload; each is streamed to disk in server/gcode/ before any validation runs. The volume also hosts the SQLite database (server/data), so filling the disk halts job tracking and can fail WAL writes mid-print-farm operation. Even the validation-failure paths (lines 129/134/143) only unlink after the full body has been written.

```
const upload = multer({ storage });
```

### 28. [Should-fix] Untracked FINISHED auto-dispatches a new job onto an uncleared bed (hold bypass for prints run outside the farm)

`server/scheduler.js:463` (scheduler) | originally rated Critical, adjusted in verification

When a print is started from the printer's own screen (calibration, test print), the poller tracks it as PRINTING with no job row. On completion, the PRINTING->FINISHED transition does NOT hold the printer, because poller.js:89 gates all holds on hasActiveJob ('shouldHold = hasActiveJob && (newStatus === FINISHED || ...)'). The statusChange handler then calls _handleFinished, which finds no printing job and no session-failed job, and immediately calls _dispatchToPrinter(printer) at line 466. _dispatchToPrinter only checks is_held and active jobs, not whether a human confirmed the bed is clear, so it uploads and starts a farm job on a plate still occupied by the just-finished external print. The new job is lost (printed onto the old object) and the printer can be physically damaged. This is exactly the FINISHED-requires-operator safety model being bypassed; the operator-confirmation hold only protects farm-tracked prints.

```
if (!job) {
  console.warn(`[scheduler] FINISHED on ${printer.name} but no printing job found — may be outside system`);
  // Still try to dispatch the next job
  this._dispatchToPrinter(printer).catch(() => {});
```

Reviewer DOWNGRADE: The control flow is accurate and reachable: for an externally started print there is no job row, so poller.js:89 leaves is_held=0 on PRINTING->FINISHED; scheduler.js:42-44 calls _handleFinished; both job lookups (printing at 443, session-failed fallback at 451-456 gated on finished_at>startedAt) miss; if(!job) at 463 fires _dispatchToPrinter at 466, which guards only on is_held (0) and active jobs (none) and will upload a matching candidate onto the uncleared bed. So NOT refuted. However Critical and the "hold bypass" label are overstated. (1) It is not the named hold-bypass mistake: no hold ever existed to clear; the code intentionally treats untracked prints as not-farm-owned (the line-464 comment is deliberate). (2) The sacred part-count invariant is untouched: the branch returns before any completed_qty change, so no double-credit or data corruption, which is the anchor for Critical in this repo. (3) The physical-collision risk is not unique to line 463: the identical dispatch-onto-uncleared-bed outcome occurs via the common printerIdle path (scheduler.js:36-40) when the printer returns to IDLE, so it is inherent to the auto-dispatch-to-idle model rather than a FINISHED-specific defect. (4) Reachability is out-of-model: requires an operator running a non-farm print on an active enrolled printer with an open matching candidate and no bed clearing within one 15s poll. Genuine physical-safety gap worth fixing (hold any untracked FINISHED before dispatch), but Should-fix, not Critical.

### 29. [Should-fix] Ceiling check counts zombie jobs on decommissioned or deleted printers, starving the part on the rest of the fleet

`server/scheduler.js:326` (scheduler)

The ceiling query sums parts_per_plate over all 'uploading'/'printing' jobs for the part without joining printers or filtering on is_active. The plain decommission route (server/routes/printers.js:232-240) sets is_active=0 without touching the printer's active job, and DELETE /api/printers/:id (printers.js:227) removes the printer while leaving job rows dangling. The poller only polls is_active=1 printers (poller.js:33), so a job stranded on a decommissioned printer never gets a FINISHED/ERROR transition and stays 'printing' forever. Its parts_per_plate keeps counting toward inProgressParts, so the scheduler believes the part is covered and skips dispatching it to healthy printers (line 331). Failure scenario: printer breaks mid-print of the last plate of a part, operator uses plain Decommission (a first-class Fleet action) instead of mark-job-failure - the part silently never completes and no other printer picks it up until someone manually fails the job or recommissions the printer. For a deleted printer there is no recovery path at all.

```
const inProgressParts = this.db.prepare(`
  SELECT COALESCE(SUM(parts_per_plate), 0) AS total FROM jobs
  WHERE part_id = ? AND status IN ('uploading', 'printing')
`).get(candidate.part_id).total;
```

### 30. [Should-fix] Silent print-start no-op leaves job 'printing' indefinitely - stale detection only runs on dispatch attempts, never on poll ticks

`server/scheduler.js:419` (scheduler)

After a successful upload the job is set to 'printing' with no verification that the print actually started (klipper.js uploadAndPrint just POSTs with print=true and returns - the documented 'silent Moonraker no-op' class). If the printer never leaves IDLE (or a Bambu stays latched on FINISHED), the poller sees no status transition, so no statusChange or printerIdle event ever fires (poller.js:70/102), and the only code that detects the stale job - the auto-fail block in _dispatchToPrinter (lines 204-235) - is never reached because dispatch attempts require a transition-driven event or a sweep. Sweeps only run at boot, project activation, /api/scheduler/dispatch, and set-ready-batch. Failure scenario: overnight lights-out operation, upload succeeds at 2am but Klipper is not ready so the print never starts; the printer sits physically idle with a 'printing' job (also counting toward the part's ceiling) until the next morning's operator action. No watchdog on the poll loop compares job state against a persistently non-printing printer status.

```
this.db.prepare(`
  UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?
`).run(Date.now(), jobId);
```

### 31. [Should-fix] Rotted suite: set-ready tests a hand-copied replica that has drifted from the real handler

`server/tests/set-ready.test.js:123` (test-coverage)

makeApp() re-implements the set-ready route inline instead of exercising server/index.js. The replica has diverged: the real handler (index.js:178-184) checks the 'uploading' job FIRST and, when printer.status is FINISHED/IDLE (index.js:296-307), credits completed_qty and marks the upload-stalled job 'finished' in one click; the replica only transitions it to 'printing' with no credit. The upload-stalled tests (lines 495-525) seed a printer whose status is 'FINISHED' (see next finding) and assert job→'printing' with completed_qty 0 - the real endpoint, given the identical DB state, marks the job 'finished' and credits 4. The suite passes while asserting behavior production does not have, so any future regression in the credit-exactly-once path (the phantom-part-credit class of bug from CLAUDE.md) would not be caught here.

```
db.prepare("UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?")
```

Reviewer DOWNGRADE: Core claim confirmed by direct comparison: server/index.js's real set-ready handler (lines 161-330) has an explicit branch `if (printer.status === 'FINISHED' || printer.status === 'IDLE')` in the upload-stalled case that credits completed_qty and marks the job 'finished' in one click, while the test file's makeApp() replica (set-ready.test.js lines 115-126, cited line 123 verified verbatim) unconditionally sets the uploading job to 'printing' with zero credit, with no printer-status check at all. The upload-stalled tests (lines 495-570) seed the printer with status 'IDLE' (not 'FINISHED' as the auditor asserted -- a factual citation error), but IDLE is one of the two statuses that trigger the real handler's credit-and-finish branch, so the divergence still holds under the actual seeded DB state: given identical data, production would credit completed_qty and finish the job, while the suite asserts completed_qty stays 0 and the job becomes 'printing'. This is a real, reachable divergence between the tested replica and shipped behavior in a part-count-adjacent path, meaning a future regression in the credit-exactly-once logic for this specific branch would not be caught by this suite. Rating as Should-fix (not upgrading to Critical) since it is a test-suite integrity gap, not an active production bug -- the real handler's own comments justify its FINISHED/IDLE credit-in-one-click behavior as intentional (avoiding a double-confirmation loop), and the flaw is that the test asserts stale/wrong expectations rather than that production credits incorrectly. The auditor's severity call matches the evidence despite the minor citation slip (claimed seeded status FINISHED when it is actually IDLE), so this is effectively a confirm with a small correction noted, hence DOWNGRADE-in-place-of-CONFIRMED only to flag that evidence detail rather than to change the rating.

### 32. [Should-fix] Batch set-ready endpoint has zero test coverage

`server/index.js:115` (test-coverage)

POST /api/printers/set-ready-batch releases holds for many printers via raw id interpolation and kicks _sweepInBatches, with none of the per-printer job-resolution/crediting logic of the single set-ready route - yet no suite touches it (checklist item 10 'including batch endpoint'). Failure scenario a test would need to catch: operator batch-readies printers whose jobs are still 'printing' (missed finish); holds are cleared without crediting, then _dispatchToPrinter's stale-job auto-fail marks those jobs failed - parts silently never credited. Whether that is intended behavior is undecidable today because nothing pins it down.

```
app.post('/api/printers/set-ready-batch', (req, res) => {
```

### 33. [Should-fix] Hold gate (no dispatch to held printers) is untested - risk item 2 uncovered

`server/scheduler.js:190` (test-coverage)

_dispatchToPrinter re-reads is_held from the DB and bails if set, and sweepIdlePrinters filters WHERE is_held = 0 (scheduler.js:76) - this is the core 'no auto-redispatch before operator sign-off' safety property, but no test seeds is_held = 1 and asserts dispatch is refused (all scheduler-file/scheduler-targeting fixtures use is_held 0). A regression that drops the fresh.is_held check (e.g. trusting the stale printer object passed in) would pass the entire suite while re-dispatching printers awaiting operator sign-off. The planned scheduler test PR should add this first.

```
const fresh = this.db.prepare('SELECT is_held, status FROM printers WHERE id = ?').get(printer.id);
    if (!fresh || fresh.is_held) {
```

### 34. [Should-fix] OFFLINE-with-printing-job no-credit branch of set-ready is untested

`server/index.js:258` (test-coverage)

The real handler deliberately skips crediting and leaves the job 'printing' when printer.status === 'OFFLINE' and the active job is printing (operator saying 'still running, resume'). The replica in set-ready.test.js lacks this branch entirely, and the seedPrinter status bug means no test can produce an OFFLINE printer. Failure scenario left unguarded: a regression that credits in this branch would double-credit when the printer later reports FINISHED and _handleFinished credits again - exactly the double-credit class in the fork's risk list (item 5).

```
if (printer.status === 'OFFLINE' && activeJob.status === 'printing') {
```

### 35. [Note] Backup export via window.location.href will fight header-based auth and downloads a credential-laden file over a bare GET

`client/src/pages/Settings.jsx:304` (client-leak) | originally rated Should-fix, adjusted in verification

Export is a full-page navigation (`window.location.href = '/api/backup'`), the one client call that cannot carry an Authorization header or go through a future fetch wrapper - if the fork's auth PR uses bearer tokens, this button breaks (or worse, forces the endpoint to stay unauthenticated). Since the backup snapshot includes the printers table, the resulting .json on disk contains every printer's api_key/access code in plaintext, and the URL lands in browser history. The auth PR needs either cookie-based sessions or a rewritten export path (fetch + blob download), and the redaction decision must explicitly cover the backup payload.

```
const handleExport = useCallback(() => {
    window.location.href = '/api/backup';
  }, []);
```

Reviewer DOWNGRADE: Read client/src/pages/Settings.jsx:303-305 (handleExport uses window.location.href = '/api/backup'), server/routes/backup.js (GET / does `SELECT * FROM printers` unredacted, which includes api_key, into the JSON bundle), server/db.js (printers.api_key TEXT NOT NULL, no redaction), and server/index.js (no auth middleware exists at all today - the whole app is unauthenticated right now, so this isn't a new exposure introduced by handleExport specifically).

The auditor's central correctness claim is conditional and speculative: "if the fork's auth PR uses bearer tokens, this button breaks." I checked PLAN.md and TASKS.md (Task 2, lines 119-141) and the actual planned auth PR is explicitly session/cookie-based via Better Auth ("Session auth... Login -> session cookie -> protected route succeeds"), not bearer tokens. Cookie-based sessions are sent automatically by the browser on any same-origin navigation, including window.location.href GETs - so the specific failure mode described (full-page navigation "cannot carry" auth and "fights" the scheme) does not apply to the auth mechanism this repo has actually chosen. The auditor guessed a bearer-token design and built the finding on that guess; PLAN.md already forecloses it.

The plaintext-credentials-in-backup observation is real (backup.js exports printers.* unredacted) but it is not new or specific to this line - every printer-returning endpoint currently leaks api_key/access_code identically, since there is no auth or redaction anywhere in the codebase yet. TASKS.md Task 3 ("Credential Redaction," lines 145-158) is already scoped to strip credential fields from "printer route handlers and any serializer returning printer objects" - this should be read to include backup.js, but the task brief doesn't explicitly name backup.js/restore.js as in-scope files, which is a legitimate documentation gap worth flagging separately, not a defect in handleExport itself.

Net: the claimed mechanism (bearer-header incompatibility from window.location.href) is refuted by the project's own auth plan. What remains true and worth keeping is a much narrower, lower-severity point: Task 3's file list should explicitly enumerate server/routes/backup.js so credential redaction isn't accidentally skipped for the export/restore path. That's a docs/planning gap, not a Should-fix code defect in Settings.jsx line 304 today.

### 36. [Note] GET /api/backup exports all printer credentials (api_key / Bambu access codes) in plaintext

`server/routes/backup.js:66` (db-backup) | originally rated Critical, adjusted in verification

The export dumps printers with SELECT *, which includes the api_key column (PrusaLink API key or Bambu LAN access code per server/db.js:26) and serial_number for every printer, and streams it as a downloadable JSON attachment. This goes beyond the accepted 'no auth yet' finding: it is a single-request, whole-fleet credential exfiltration endpoint (curl http://host/api/backup yields LAN control of every physical printer), and the same plaintext keys also land in every downloaded backup file that operators will store/share. When the fork adds auth (PR 2), this endpoint must be gated first, and the fork should decide whether backups carry keys in plaintext at all (the hourly .db snapshots in server/data/backups necessarily contain them too).

```
const printers        = db.prepare('SELECT * FROM printers').all();
```

Reviewer DOWNGRADE: The cited mechanics are accurate and reachable: backup.js:66 does `SELECT * FROM printers`, which includes api_key (db.js:26, NOT NULL) and serial_number (db.js:97), embeds them in the JSON bundle, and streams it as a downloadable attachment (lines 103-105). The route is mounted at /api/backup (index.js:45) with no auth middleware anywhere in index.js, so `curl http://host/api/backup` yields all plaintext credentials. However, the auditor's central claim, that this endpoint is a DISTINCT credential-exfiltration surface that goes BEYOND the accepted 'no auth yet' finding, is refuted by the primary printers API: server/routes/printers.js:42 (`GET /api/printers` -> `SELECT p.*`) already returns every printer's api_key for the whole fleet in one unauthenticated request, and printers.js:116 plus the POST/PUT responses (lines 141, 214) re-select and return the full row including api_key. The exact same plaintext whole-fleet credential exposure the auditor attributes uniquely to /api/backup is already served by the endpoint that backs the normal Fleet/Settings UI, under the identical no-auth condition. So the 'single-request whole-fleet exfiltration -> LAN control' framing is fully redundant with existing behavior and is simply one facet of the already-accepted global no-auth finding, not a new Critical. The only genuinely non-redundant concern is data-at-rest: keys land in downloaded/shared backup JSON and hourly .db snapshots. That is a legitimate design consideration for the fork's PR-2 auth/backup work, but it is not a correctness defect and sits far below Critical when the same credentials are already freely readable live. Hence DOWNGRADE to Note.

## Disputed findings (1)

One reviewer refuted or downgraded each of these; severity shown is post-dispute.

### [Should-fix] Restore does not quiesce the scheduler/poller; an in-flight dispatch straddling the restore writes to the replaced jobs table by stale rowid

`server/routes/backup.js:148` (db-backup), originally Critical

The restore transaction is synchronous and atomic, but the scheduler's dispatch is async around it: _dispatchToPrinter inserts a probe job and captures jobId (scheduler.js:308-311), then suspends at `await driver.uploadAndPrint(...)` (scheduler.js:374, plus 5s/60s retry sleeps at :386). If POST /api/backup/restore runs during that await, it deletes all jobs and re-inserts the backup's jobs with their original IDs - which overlap with live IDs since the backup is the same DB lineage. When the dispatch resumes, `UPDATE jobs SET status='printing' ... WHERE id = ?` (scheduler.js:401/420) now targets a different restored job (different part, different printer). When that printer later reports FINISHED, _handleFinished credits completed_qty to the wrong part (scheduler.js:473-478) - the miscredit/double-credit class CLAUDE.md warns about - while the print physically running on the dispatching printer has no correct job record and its parts are never counted. The router is constructed with db only (index.js:27) before the poller/scheduler exist (index.js:88-89), so it has no way to pause, drain _activeUploads/_pendingPrinters, or resync poller state after wholesale printer-row replacement.

- REFUTED: The finding's load-bearing mechanism - that after a mid-await restore, the resumed `UPDATE jobs SET status='printing' WHERE id = jobId` (scheduler.js:401/420) targets "a different restored job (different part, different printer)" by stale rowid - cannot occur. `jobs.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (db.js:69). The probe job (scheduler.js:307-311) captures `jobId = lastInsertRowid`, a fresh monotonic value strictly greater than every job ID that has ever existed, hence greater than every ID in an earlier-exported backup. Restore's sqlite_sequence sync (backup.js:200-204) sets seq to MAX(id) of restored rows, still < jobId. So after DELETE FROM jobs and reinsertion with original IDs, no restored row has id == jobId; the resumed UPDATE matches ZERO rows and is a no-op, not a mis-target. There is no cross-wired job to later credit. The claim that _handleFinished then credits the wrong part also does not follow from jobId: _handleFinished (scheduler.js:443-448) resolves the job by printer_id AND status='printing', never by the captured jobId, so the cited stale-rowid write is irrelevant to crediting. Interleaving is also constrained: the restore transaction (backup.js:207) is fully synchronous on a single-threaded loop, so it runs atomically in the await gap with no partial interleaving. What remains is only the inherent property that a deliberate, documented "replace all farm data" restore replaces the DB, so a print physically running during a restore is reconciled against the backup's state afterward. That is not the filed "writes to the replaced jobs table by stale rowid" mechanism, requires an operator to fire a full restore inside a seconds-long upload window, and in the common case yields "no printing job found" (no credit) rather than a phantom credit. The specific Critical mechanism as described is refuted.
- CONFIRMED: Read server/routes/backup.js (108-230) and scheduler.js (300-425, 429-493) directly.

Confirmed facts:
- The restore handler is constructed with `db` only (matches claim about index.js:27 vs 88-89 - no scheduler/poller reference exists in this file to pause anything).
- `_dispatchToPrinter` synchronously inserts a probe job at scheduler.js:307-311 and captures `jobId = jobRow.lastInsertRowid`, then suspends at `await driver.uploadAndPrint(...)` (line 374) with 5s/60s retry sleeps (line 386). This is a genuine multi-tick await window during which the Node event loop can run other queued work, including an Express request handler.
- `restore()` (backup.js:148-205) is a `db.transaction` - synchronous and atomic once it starts running - but nothing in the codebase pauses the poller or gates the scheduler's in-flight async dispatch before that transaction executes. It unconditionally `DELETE FROM jobs`, then reinserts backup jobs with their original ids, then resyncs `sqlite_sequence` to `MAX(id)` of the restored table (lines 194-204).
- After restore, scheduler.js:401/420 (`UPDATE jobs SET status='printing' ... WHERE id = jobId`) and later `_handleFinished` (scheduler.js:443-479, crediting `completed_qty`) operate against whatever now occupies that row, with zero synchronization against the restore.

Where the literal claim needed scrutiny: under the single-machine, recent-periodic-backup case, monotonically increasing ids usually keep `jobId` ahead of anything in an older backup, so the stray UPDATE is more likely to silently no-op (0 rows matched) than to hit an unrelated job - meaning the dominant failure mode is a lost/untracked job (print runs, finishes, `_handleFinished` finds no matching row, part never credited) rather than a clean "wrong part credited" swap. However, this is still squarely a "job loss" outcome under CLAUDE.md's own Critical definition. And the auditor's exact "different part, different printer" collision is realistic too, not hypothetical: docs/Settings.jsx explicitly market restore as usable to sync/restore state onto a different machine ("Use the same file to restore on another machine or recover from data loss" - Settings.jsx:1064), so a backup imported from another farm instance's independent id sequence colliding with a locally in-flight `jobId` is a documented, intended use case, not an edge case requiring luck.

Net: the code fully supports the core claim - restore is not quiesced against in-flight scheduler dispatch, and a race here corrupts job/part-count tracking for a live print, satisfying the project's own Critical bar (job loss / mis-credit). The precise causal narrative (guaranteed wrong-part overwrite via id collision) is somewhat overstated for the common same-machine case, but the underlying critical-severity impact holds either way (lost credit or wrong-part credit, both Critical per this repo's own rubric), so I'm not downgrading.

## Notes (33, unverified)

- `server/scheduler.js:229` (scheduler) **Crash-restart within the 90s grace window strands an orphaned 'uploading' job with no retry**: If the server crashes mid-upload and restarts quickly, the boot sweep finds the orphaned 'uploading' job younger than STALE_JOB_GRACE_MS, logs 'skipping duplicate dispatch, not yet stale', and returns null - but nothing ever revisits the printer: the upload is not resumed, no timer re-checks after the grace expires, and the printer's IDLE status never transitions so printerIdle never fires. The job blocks all future dispatch to that printer (activeJob guard at line 204) until the next manual sweep (project activation or 'scan for jobs'), at which point it is auto-failed and the printer held. Low impact because any later sweep self-heals it, but between restart and that sweep the printer is silently out of service.
- `server/db.js:90` (db-backup) **Migration catch(_){} swallows every error class, not just 'duplicate column'**: The additive migration pattern is accepted by design, but the blanket catch cannot distinguish 'duplicate column name' from SQLITE_BUSY (an external process - sqlite3 CLI, a second server instance - holding a lock at boot), SQLITE_FULL, or SQLITE_IOERR. In those cases the column is simply never added and the failure surfaces later as confusing 'no such column' 500s in routes (e.g. parts.sort_order at line 93 is ORDER BY'd by the scheduler candidate query, scheduler.js:295). Checking err.message for 'duplicate column' and logging anything else would keep the design while making real failures visible.
- `server/db.js:18` (db-backup) **No busy_timeout pragma - any external process holding a lock makes writes throw SQLITE_BUSY immediately**: WAL is enabled but busy_timeout is left at 0. Within the single Node process this is harmless (one synchronous connection cannot contend with itself, and route + scheduler writes serialize on the event loop - the checklist's concurrent-write concern is a non-issue in-process). But the moment an operator opens server/data/farm.db with the sqlite3 CLI or a script and takes a write lock, every route and scheduler write throws SQLITE_BUSY instantly instead of waiting, and most call sites do not handle it. `db.pragma('busy_timeout = 5000')` is a one-line safety net.
- `server/backup.js:21` (db-backup) **Hourly snapshots: same-hour restart overwrites the hour's snapshot, and backups live on the same volume as the live DB**: runBackup fires at startup (line 50) and the filename has hour granularity, so a restart overwrites the current hour's snapshot with the present DB state. Concrete loss scenario: a bad POST /api/backup/restore wipes the farm at 09:10; the operator restarts the server at 09:20; the startup backup overwrites farm-...-09.db - the most recent good pre-restore snapshot - leaving only the 08:00 state to recover from (up to ~70 minutes of work lost). Snapshots also live under server/data/backups on the same disk as farm.db, so they provide no protection against volume loss, and they contain plaintext printer api_keys like the live DB. The db.backup() online-backup API itself is used correctly and is WAL-consistent.
- `server/routes/backup.js:82` (db-backup) **Export builds the entire bundle, including all gcode files as base64, in memory - fails on large farms and cannot round-trip past 500 MB**: Every gcode file is readFileSync'd and base64-encoded into one object, then res.json() must JSON.stringify the whole thing. A farm with a few GB of gcode will exceed V8's string length limit (~512 MB) or exhaust heap, making export throw exactly when the farm is big enough to care about backups. Independently, the restore endpoint caps uploads at 500 MB (line 15), so any export larger than that cannot be restored even if it downloads. The hourly .db snapshots do not include gcode files at all, so at scale there is no working full-backup path.
- `server/db.js:148` (db-backup) **printer_models auto-seed defaults unknown models to the 'prusa' connector**: The one-time seed for existing installs maps any in-use model id not present in KNOWN_MODEL_META to connector 'prusa'. A legacy install with a nonstandard Bambu/Elegoo model id (typo, or a model added after this list was written) gets a printer_models row that routes its printers through the PrusaLink driver - the silent Moonraker-no-op class of failure, where dispatch attempts go nowhere. Since INSERT OR IGNORE never revisits the row, the wrong connector persists until the operator notices and edits it in Settings.
- `server/routes/printers.js:470` (routes-credentials) **CSV import echoes api_key values back in flagged rows**: Rejected rows are returned verbatim in summary.flagged ({ row, reason } at lines 470, 481, 488, 499; res.json(summary) at 503), and row includes the api_key column. The client sent the file, so this is not a new disclosure to that client, but the response (containing plaintext access codes) may be logged by proxies or persisted by the UI. Relevant to the fork's redaction PR for completeness.
- `server/routes/printers.js:124` (routes-credentials) **Printer type is never validated against the known connector list**: POST /api/printers (line 124: type || 'prusa'), PUT /:id, and CSV import (line 466) accept any string as type, even though models.js:5 defines VALID_CONNECTORS. Impact is contained: the scheduler resolves the driver up front and holds the printer on unknown type (scheduler.js:249-256), so no job rows are stranded - but a typo'd type ('purs a', 'bamboo') silently produces a printer that never polls and is held on first dispatch, with the misconfiguration only visible in server logs. Also, type is not cross-checked against the model's registered connector, so a 'prusa'-type printer can carry a bambu-connector model.
- `server/routes/settings.js:9` (routes-credentials) **GET /api/settings returns every settings row; ALLOWED_KEYS is write-only**: The read path dumps the entire settings table while ALLOWED_KEYS (dispatch_batch_size, farm_name) only constrains writes. No secret keys exist in the table today (verified: only these two keys are read/written across the codebase), so there is no current leak - but the moment the fork stores anything sensitive in settings (auth secret, webhook token, SMTP password), it round-trips to every client automatically. The auth PR should either allowlist the read path too or keep secrets out of this table.
- `server/index.js:115` (routes-credentials) **Five state-mutating endpoints are registered inside the app.listen callback, outside the router mounting block**: /api/projects (line 92), /api/scheduler/dispatch (107), /api/printers/set-ready-batch (115), /api/printers/:id/recommission (134), and /api/printers/:id/set-ready (161) are attached after the server starts, in a different place from the /api routers at lines 40-49 - and set-ready-batch/recommission/set-ready deliberately squat inside the /api/printers namespace owned by printersRouter. A global app.use(auth) placed before line 40 will still cover them (registration order), but any per-router auth strategy (wrapping each router at mount time, which is the natural reading of lines 23-49) silently misses exactly the endpoints that release holds, credit inventory, and trigger dispatch. Also relevant to auth scoping: GET /api/health (52) and the notifications endpoints (57-62) sit in the same global path, and the SPA catch-all (80-82) plus express.static (78) serve the client bundle unauthenticated. Additionally, /:id/set-ready and /:id/recommission read req.body optionally (req.body || {}, req.body?.note), so they execute from a cross-site HTML form POST with no JSON body - cookie-session auth without CSRF protection would not stop cross-site triggering; use a token header.
- `server/routes/jobs.js:63` (routes-files) **Job cancel endpoint only accepts status 'queued', which no runtime code ever creates**: DELETE /api/jobs/:id rejects everything except status === 'queued'. The only production INSERT INTO jobs is scheduler.js:308, which creates jobs directly as 'uploading' ('queued' appears only as the schema default and in tests/seed data). So every real job is uploading/printing/terminal and every cancel attempt returns 409 - the endpoint is dead against live data, and the UI has no working way to cancel a dispatched job. The upside is that no client action can desync scheduler state through this route; the downside is the cancel feature does not exist in practice, and the various 'cancel queued jobs' sweeps (scheduler.js:512, index.js:278) are likewise no-ops.
- `server/routes/projects.js:218` (routes-files) **Duplicate's copy-failure fallback makes two projects share one physical G-code file**: If fs.copyFileSync throws (disk full, permissions) - or the source file is already missing (line 221) - the new gcode row is written with newFilepath = gcode.filepath, i.e. both the original and the duplicate reference the same physical file, directly contradicting the route's own comment ('deleting one won't affect the other', lines 172-173). Failure scenario: operator later deletes the original draft project (projects.js:94 unlinks the file) or the original part (parts.js:227); the surviving duplicate's gcode now points at a nonexistent file and the scheduler skips that part at dispatch time (scheduler.js:345-353) until someone re-uploads. Recoverable via the missing-file notification, hence Note.
- `server/routes/gcodes.js:158` (routes-files) **Uploaded file orphaned on disk when the gcode INSERT throws**: foreign_keys = ON is set (server/db.js:19), so POSTing a part_id that does not exist (e.g. part deleted between form load and submit) makes the INSERT throw a FOREIGN KEY error after the file has been written; the route has unlink cleanup only on its three explicit validation branches (lines 129, 134, 143), so the handler 500s via Express's default error path and the file stays in server/gcode/ forever. Same for any other insert failure (NaN parts_per_plate binding aside). There is no orphan-file sweep anywhere in the server, so these accumulate silently alongside the disk-fill exposure from the missing upload limits.
- `server/routes/parts.js:115` (routes-files) **dispatch-status omits the scheduler's on-disk file-existence check (sync pair drift)**: The endpoint mirrors sweepIdlePrinters eligibility and the candidate filters (model, group, material/color, hold state) faithfully, but not the scheduler's fs.existsSync gate (scheduler.js:345): a part whose G-code file was lost (e.g. via the shared-file duplicate fallback, or manual deletion from server/gcode/) reports dispatchable: true while the scheduler permanently skips it. Failure scenario: operator uses the 'why isn't my part printing' diagnostic, is told the part is dispatchable, and is left chasing printer state instead of the missing file (the only clue is a one-time notification from the scheduler).
- `server/routes/projects.js:116` (routes-files) **Force-complete's three writes are not wrapped in a transaction**: POST /:id/complete closes parts (line 116), cancels jobs (line 122), and completes the project (line 127) as separate statements, unlike the delete and duplicate routes which use db.transaction. A crash or thrown error between the statements leaves parts closed while the project stays 'active' - a state the UI cannot express (project looks active, nothing dispatches, reactivate finds nothing to reopen because parts are closed with completed_qty possibly < target... those would be reopened, but the project row was never completed so the operator may not think to reactivate). Small crash window, easily fixed by wrapping in db.transaction like the sibling routes.
- `server/routes/parts.js:166` (routes-files) **Manually closing a part via PUT skips the scheduler's close side-effects (project completion, queued-job cancel)**: When a PUT sets completed_qty >= target the route computes resolvedStatus = 'closed' and writes it, but does not run the equivalent of scheduler._closePart (scheduler.js:506-527), which also cancels queued jobs for the part and marks the project 'completed' when its last part closes. Failure scenario: operator hand-enters final counts for the last open part of a project; the part closes but the project remains 'active' with zero open parts indefinitely - dashboards keep showing it as an active project and it never reaches the completed state (the reverse direction, reopen-on-raise, IS handled at lines 194-199, making the asymmetry easy to miss).
- `server/drivers/bambu.js:301` (driver-bambu) **print payload hardcodes Metadata/plate_1.gcode and interpolates the raw filename into the ftp:// URL without encoding**: param is always 'Metadata/plate_1.gcode', so a multi-plate .3mf where the sliced plate is not plate 1 (a common 'export all plates' operator mistake in Bambu Studio) is rejected by firmware after upload - and because of the no-start-verification gap (finding 1), the job is still marked 'printing' and sticks. Separately, onPrinterFilename is embedded verbatim in url: `ftp:///${onPrinterFilename}`; filenames containing spaces or non-ASCII characters (multer preserves the original basename after the timestamp prefix) are not URL-encoded and can fail firmware URL parsing. Workaround exists: enforce single-plate ASCII-named .3mf exports.
- `server/drivers/bambu.js:365` (driver-bambu) **cancelJob is a silent no-op when disconnected and logs 'Job cancelled' without confirming the publish**: cancelJob returns normally (console.warn only) when the connection map has no entry or conn.connected is false, and the stop publish has no callback - the success log at line 374 prints unconditionally. Currently latent: no route or scheduler path calls cancelJob (routes/jobs.js:58-69 only cancels 'queued' jobs), so there is no live failure today. But the moment the fork wires up a cancel-running-print endpoint (likely alongside the auth work), a disconnected Bambu will have its job marked cancelled in the DB while the physical print continues - a hold-bypass-adjacent hazard the repo's CLAUDE.md history warns about. The function should throw when it cannot deliver the stop command.
- `server/drivers/bambu.js:132` (driver-bambu) **gcode_state values INIT, SLICING, and OFFLINE (documented in OpenBambuAPI) map to UNKNOWN, which the poller treats as a hold-worthy state**: mapStatus covers RUNNING/PREPARE/IDLE/PAUSE/FINISH/FAILED; OpenBambuAPI also documents INIT, SLICING, OFFLINE, and UNKNOWN as possible gcode_state values, all falling to 'UNKNOWN' here. poller.js:84-89 treats any non-SAFE_STATES status transition as hold-worthy when an active job exists, so a printer passing through a brief SLICING/INIT report mid-job (e.g. immediately after a project_file dispatch, or a firmware reboot mid-print) sets is_held=1 and demands operator confirmation for a print that is actually proceeding. Defensible as fail-safe behavior, but it produces false operator holds; mapping SLICING/PREPARE-like states to PRINTING would avoid them.
- `server/drivers/index.js:21` (driver-bambu) **A driver module that throws at require time is misreported as 'unknown printer type' and permanently holds printers**: getDriver invokes the loader with no distinction between an unregistered type and a driver whose require() failed (e.g. the mqtt or basic-ftp native/optional dependency missing after a bad install). Node purges a module from the require cache when its evaluation throws, so every call re-throws. Both call sites catch the error but assume it means a bad type string: poller.js:60-63 logs 'has unknown type ... skipping poll' and scheduler.js:251-257 sets is_held=1 with 'unknown type ... no job created'. Failure scenario: a broken node_modules for one dependency silently converts every Bambu printer into a permanently held fleet with a misleading diagnostic, instead of failing loudly at startup. No data loss; restart after npm install fixes it.
- `server/drivers/elegoo-centauri.js:31` (drivers-other) **Enabled AutoReconnect activates a hardcoded developer IP remap inside the sdcp dependency (10.1.1.45 → 10.1.1.43)**: The pinned sdcp package's reconnect path contains a leftover test hack: in SDCPPrinterWS.js's close handler, `if (MainboardIP === "10.1.1.45") MainboardIP = "10.1.1.43";` before reconnecting. The driver sets `client.AutoReconnect = 5000`, so this code path is live. Failure scenario: a farm that happens to assign a Centauri Carbon the IP 10.1.1.45 would, after any TCP drop, silently reconnect to 10.1.1.43 - status polls and Stop/Start commands would target a different device. Probability is low (one specific IP) but the consequence is commanding the wrong physical printer; worth vendoring or patching the dependency before un-deferring this brand.
- `server/drivers/prusa.js:96` (drivers-other) **cancelJob is a silent no-op stub that resolves successfully; cancelJob is currently dead code across all drivers**: The Prusa cancelJob body is empty and resolves as if the cancel succeeded, so any future caller (e.g. a UI cancel button added by the fork) would report success while the printer keeps printing - the 'silent no-op' pattern CLAUDE.md warns about. Verified mitigation: no code in server/ (routes, scheduler, index) currently calls cancelJob on any driver, so there is no runtime impact today. If the fork wires up job cancellation, this stub must either be implemented (PrusaLink v1 supports DELETE /api/v1/job/{id}) or made to throw so failure is visible.
- `server/drivers/elegoo-centauri2.js:273` (drivers-other) **uploadAndPrint buffers the entire G-code file in memory**: `fs.readFileSync(gcodeFullPath)` loads the whole file, then MD5s it and slices 1 MB chunks from the buffer. G-code files for large plates can run to hundreds of MB; several simultaneous CC2 dispatches in one sweep batch would multiply that in resident memory. The chunked-PUT protocol only needs streaming reads (as the CC1 driver's sdcp UploadFile does with a file handle). No correctness failure - worst case is memory pressure/OOM on a small host during a bulk sweep. Otherwise this driver is the healthier of the two Elegoo drivers: all MQTT waits are bounded (2 s connect wait, 8 s registration, 10 s per command), errors drop and rebuild the connection, and the access code is never logged.
- `.github/workflows/docker-publish.yml:118` (deploy-ci) **Upstream publishes mutable :latest and nightly-rebuilt :edge - fork must pin semver tag or digest**: Every push to main retags :latest and :edge, and the daily cron (line 9-10, `0 3 * * *`) rebuilds and re-pushes from main even with no code change; since the base image `node:22-bookworm-slim` is not digest-pinned in the Dockerfile, the bytes behind :latest silently change nightly. A farm deployment tracking :latest (as docker-compose.yml's `image: print-farm-manager:latest` naming encourages) can pick up an untested upstream main-branch build on any restart with pull. For the fork decision: deploy only from `type=semver` tags ({{version}} / {{major}}.{{minor}}) or image digests. Secrets usage is otherwise clean - only GITHUB_TOKEN with contents:read/packages:write, and PR events never push (build gated by `if: github.event_name != 'pull_request'`).
- `Dockerfile:31` (deploy-ci) **No HEALTHCHECK - restart policy cannot recover a hung server**: The runtime image defines no HEALTHCHECK and docker-compose.yml has no healthcheck block, so `restart: unless-stopped` (docker-compose.yml line 8) only recovers a crashed process. If the Node event loop wedges (e.g. a stuck synchronous better-sqlite3 call on a corrupted volume, or an MQTT reconnect storm) the container stays 'Up' while every printer poll and dispatch silently stops - on a farm, that means jobs stop flowing until a human notices. A simple HTTP healthcheck against :3000 plus autoheal or depends_on:condition would close this.
- `docker-compose.yml:9` (deploy-ci) **Production port published on all host interfaces**: `"3000:3000"` binds 0.0.0.0 on the host, so the unauthenticated app (and dev's :5173/:3000 the same way, lines 30-31) is reachable by every device on the LAN, not just the operator machine. This is not the absence-of-auth finding itself; it is the deployment default that maximizes its blast radius and that the fork's auth work should pair with (bind "127.0.0.1:3000:3000" or a reverse proxy) since printer access codes and full printer control sit behind these ports.
- `package.json:35` (deploy-ci) **better-sqlite3 pinned at old major 9.x, compiled from source on Node 22**: better-sqlite3 ^9.6.0 (lockfile: 9.6.0) predates official Node 22 support (added in v11), which is why the Dockerfile installs python3/make/g++ to compile it from source. Current major is 12.x. Two consequences: the Windows farm machine running update.bat's `npm install` needs MSVC build tools present or the install fails (and per the update.bat finding, fails silently); and the fork inherits a three-majors-behind native module with no upstream fixes for newer Node ABIs. Full runtime dep list for the record: axios 1.16.0, basic-ftp 5.3.1, better-sqlite3 9.6.0, concurrently 8.2.2, express 4.22.2, form-data 4.0.6, mqtt 5.15.1, multer 2.2.0, papaparse 5.5.3, sdcp 0.5.4 - all except better-sqlite3 are current and clear of the known CVE classes (multer is 2.x, not the vulnerable 1.x line; tar-fs transitively at 2.1.4, past its traversal CVE).
- `patches/sdcp+0.5.4.patch:9` (deploy-ci) **sdcp 0.5.4 is a locally-patched, effectively unmaintained dependency; the patch suppresses a debug dump of the printer object**: The Elegoo driver depends on sdcp 0.5.4, a niche package whose upstream ships `console.log(Printer)` on every WebSocket connect - dumping the entire printer object (connection state, IP, internal fields) to stdout/container logs. The patch-package patch removes those two lines; it is the only thing preventing that log noise/exposure, and it is applied via the postinstall hook (package.json line 30, `"postinstall": "patch-package"`). The protection chain is sound in Docker (npm ci in the deps stage fails hard if the patch does not apply), but on the Windows path it depends on update.bat's flawed install check (see that finding). For the fork: treat sdcp as vendored-in-all-but-name and expect no upstream fixes.
- `server/tests/projects-reorder.test.js:130` (test-coverage) **Priority-ordering tests run against a duplicated, simplified copy of the scheduler candidate SQL**: CANDIDATE_SQL is a hand-maintained copy of the query in scheduler.js:283-296 minus the allowed_groups/required_material/required_color clauses and excludeClause. The copy currently matches on ordering semantics, but if the scheduler's ORDER BY or WHERE changes, these tests keep passing against the stale copy (same rot pattern that already bit set-ready.test.js). New tests should call _dispatchToPrinter, as scheduler-targeting.test.js does.
- `server/scheduler.js:380` (test-coverage) **UPLOAD_CONFLICT wait path in the scheduler is untested (risk item 8 partial)**: prusa-driver.test.js and octoprint-driver.test.js verify drivers throw err.code = 'UPLOAD_CONFLICT' on 409, but scheduler-file.test.js exercises retries only with generic Error('ETIMEDOUT'/'ECONNRESET') - the scheduler's distinct handling of a conflict (isConflict branch: wait-for-current-print rather than retry/hold) is never asserted. A regression that treats 409 as a normal failure would exhaust retries and hold a printer that is legitimately mid-print, and no test would notice.
- `server/scheduler.js:307` (test-coverage) **No test for restart with an orphaned 'uploading' probe job (risk item 7)**: The 'uploading' job INSERT acts as the dispatch lock; a crash between this INSERT and the driver upload leaves an orphaned 'uploading' row across restart. Operator resolution endpoints are tested (set-ready upload-stalled - via the rotted replica - and mark-job-failure in printers-decommission.test.js), but nothing tests that the restarted scheduler/sweep neither re-dispatches the printer past the orphan nor double-inserts a second probe for the same part. The planned recovery-test PR should simulate this state directly (seed an old 'uploading' job, run a sweep).
- `client/src/pages/Projects.jsx:246` (client-leak) **Raw XMLHttpRequest for gcode upload bypasses any future fetch-based auth wrapper**: The gcode upload uses a hand-rolled XHR for progress reporting (`xhr.open('POST', '/api/gcodes/upload')`) while every other call in the app uses fetch(). If the auth PR adds a fetch wrapper or interceptor to attach tokens, this one call site is silently missed and uploads start failing with 401 (or the endpoint gets left open). There is also no shared API client anywhere - roughly 60 bare fetch('/api/...') call sites across the pages - so cookie-based auth is the only option that does not require touching all of them.
- `client/src/pages/Settings.jsx:802` (client-leak) **Credential entry fields are type="text", leaving access codes visible on screen**: The Add Printer form's API Key / Access Code input (Settings.jsx lines 802-808) and the PrinterDetail edit form's API Key input (PrinterDetail.jsx lines 355-360) are plain text inputs, so entered credentials are shoulder-surfable on the operator floor and visible on the wall-mounted TV-mode setups this app targets. Input to the redaction PR: switch to type="password" (with optional reveal) and autoComplete="off" when reworking these fields.

## Refuted during verification (4)

Reported by an auditor, struck down by every adversarial reviewer. Kept for transparency; do not act on these.

- `server/scheduler.js:76` (scheduler) ~~Prusa READY state is treated as safe but is never dispatched to by any automatic path~~: The finding misreads what PrusaLink's READY state means. docs/driver-authoring.md line 125 and docs/CHANGELOG.md ("READY state clarification", lines 1858-1862) both document it explicitly: READY = PrusaLink's "Prepared" state, meaning a print job is already loaded on the printer and armed, waiting for a person to press the physical start button - it is NOT an "available for dispatch" state and is 
- `server/routes/printers.js:210` (routes-credentials) ~~Serial numbers are written in plaintext into printer_events and served/backed up from there~~: Read server/routes/printers.js in full (PUT /:id at lines 155-207) and its callees: server/events.js, server/routes/events.js, server/routes/backup.js, plus the fork's own PLAN.md/TASKS.md and server/drivers/bambu.js.

The mechanics the auditor cites are accurate as code: FIELD_LABELS includes serial_number, api_key is excluded, and events.insert writes "Serial number: old -> new" into printer_eve
- `server/tests/set-ready.test.js:184` (test-coverage) ~~seedPrinter silently ignores the status override, so intended scenarios never run~~: The claim asserts "the real handler branches on printer.status ('FINISHED'/'IDLE' credit path vs OFFLINE resume path vs mid-print transition)" - but that is false for the code actually under test here. Reading the makeApp handler (set-ready.test.js lines 27-136), it queries `printer` only for existence (line 28) and to flip `is_held` at the end (line 129); every branch that decides normal-finish v
- `client/src/pages/Settings.jsx:396` (client-leak) ~~CSV import flow depends on the server echoing raw api_keys back in the flagged-rows response~~: Read Settings.jsx:351-413 and server/routes/printers.js:434-504. The evidence cited is accurate as a description of current behavior: POST /api/printers/import does push { row, reason } (row includes api_key) into summary.flagged for missing-field/model/insert-conflict cases (printers.js:470,481-484,488-491,499), the client stores that in setResult(data) (Settings.jsx:370), and handleSaveFlagged r

## Subsystem summaries

**scheduler**: The scheduler subsystem (server/scheduler.js, server/poller.js, server/events.js) is carefully written and the documented past-bug protections genuinely exist in current code: the job-row-as-dispatch-lock is sound because every guard check and the INSERT happen synchronously before the first await (scheduler.js:187-310), the stale-status replay gate (finished_at > scheduler.startedAt) is present at scheduler.js:453-456, _handleFinished flips the job to 'finished' synchronously before crediting so poll flaps and duplicate statusChange emissions cannot double-credit, and event listeners are registered exactly once from index.js. The real defects are at the seams: an untracked (operator-initiated) print finishing triggers immediate auto-dispatch onto an uncleared bed because the poller's hold gate requires a tracked job (Critical); the stale-job auto-fail is checked before the in-flight-upload guard, so a sweep during a slow or 409-retrying upload kills the live job and can later yield a phantom part credit via the set-ready failed-job fallback; and the ceiling calculation counts zombie jobs stranded on decommissioned/deleted printers, silently starving the affected part. There is also no poll-driven watchdog for the upload-succeeded-but-print-never-started case, and Prusa READY printers are safe-listed but unreachable by every automatic dispatch path. Overall code quality is high - comments accurately describe intent and most races were clearly reasoned about - but the fixes here are all small and worth taking before forking.

**db-backup**: The db-backup subsystem is better than typical hobby-farm code: the JSON export is a consistent snapshot (all table reads happen in one synchronous tick of a single better-sqlite3 connection), restore is wrapped in a single db.transaction with correct FK-ordered deletes and sqlite_sequence resync, the restore path sanitizes gcode filenames against traversal, and the claimed sync-pair design is real - export uses SELECT * and restore derives its column lists from PRAGMA table_info of the live schema (server/routes/backup.js:43), so there are no hardcoded column lists to drift. The hourly file backup correctly uses better-sqlite3's online backup API, which is WAL-safe. The two serious problems are operational: the unauthenticated backup export hands out every printer credential in one GET, and restore does nothing to quiesce the live scheduler/poller, so an in-flight async dispatch straddling a restore writes into the replaced jobs table by stale rowid - exactly the wrong-part-credit class the project's history warns about. The migration system's blanket catch(_){} also has two spots where a partial failure is worse than the accepted "duplicate column" swallow: a non-transactional table rebuild that can leave foreign_keys OFF silently, and an unguarded jobs rebuild that can crash-loop the server.

**routes-credentials**: The routes-credentials subsystem is functionally careful about operator workflows (the set-ready state machine encodes real lessons from past bugs, and the scheduler integration correctly defers dispatch during sweeps) but has zero credential hygiene: every endpoint that returns a printer - ten in routes/printers.js plus set-ready and recommission in index.js - serializes the full row including api_key (the Bambu LAN access code / Prusa API key) and serial_number, and serial numbers additionally leak into the permanent printer_events timeline. The inline operator endpoints in index.js are the riskiest code: set-ready has no is_held precondition, no idempotency, and an ungated cancelled-job fallback, so stale-UI or duplicate requests can phantom-credit or double-adjust inventory and cascade into closing parts and cancelling queued jobs; set-ready-batch bypasses the crediting logic entirely so missed-finish plates get auto-failed uncredited; and recommission dispatches on a status column frozen since decommission. CSV import is injection-safe (fully parameterized) but buffers unbounded uploads in memory and echoes access codes back in flagged rows. Settings hold no secrets today, though the read path dumps the whole table. For the auth PR, the main structural hazard is that five state-mutating endpoints are registered inside the app.listen callback in the /api/printers namespace, where per-router middleware wrapping would miss them; a single global middleware before line 40 of server/index.js works, plus token-header (not cookie-only) auth since several endpoints execute without a JSON body.

**routes-files**: The routes-files subsystem is generally well built: all SQL is parameterized (the only string interpolation is `?` placeholder lists and a hardcoded status constant), destructive cascades (part delete, project delete, duplicate) use transactions, the /reorder routes are correctly registered before /:id, and the feared upload path-traversal is actually neutralized because busboy 1.6.0 basenames the multipart filename for both / and \ before multer's diskStorage joins it. The serious problems are at the seams: the unauthenticated dashboard endpoint returns SELECT p.* and thereby ships every printer's api_key/access code to any client (the one Critical), allowed_groups is stored unvalidated and a malformed value throws inside the scheduler's json_each candidate query, silently stalling dispatch for an entire printer model; force-completing a project 'cancels' uploading jobs that the scheduler then unconditionally flips back to printing (later crediting a closed part); and project duplication silently drops material/color/group restrictions from copied G-codes. Upload handling lacks any size or type limits and leaks orphan files on insert failure. The client-facing job-cancel endpoint targets a 'queued' status that no runtime code ever creates, so it is dead in practice - which conveniently also means no client action can desync the scheduler through it.

**driver-bambu**: The Bambu driver (server/drivers/bambu.js) is well above hobby-project quality: the push-based MQTT model is correctly implemented for better-sqlite3-era polling (getStatus never throws, returns instantly from cache, OFFLINE until first push), the user-cancel disambiguation (FAILED + print_error 50348044/0 -> STOPPED) matches ha-bambulab and OpenBambuAPI, partial-update merging is handled, and the documented stale-FINISHED-replay protection genuinely exists in scheduler.js (_handleFinished's failed-job recovery is gated on finished_at > this.startedAt). No printer access-code exposure was found in logs, error messages, or payload logging. The two real defects are lifecycle gaps: uploadAndPrint fire-and-forgets the MQTT print command with no delivery or acceptance verification, which can stick a job in 'printing' against an idle printer with no auto-recovery path (the documented silent-no-op bug class), and the per-printer connection cache is never invalidated - dropConnection is dead code, so IP/access-code edits, decommission, and delete all leave stale MQTT clients reconnecting forever. Remaining findings are latent or low-impact: an unused silent-no-op cancelJob, hardcoded plate_1 and unencoded filenames in the print payload, unmapped INIT/SLICING states causing false operator holds, and the driver registry conflating require-time failures with unknown printer types.

**drivers-other**: The deferred-brand drivers split cleanly into two tiers. klipper.js, octoprint.js, and prusa.js are solid: every HTTP call has an explicit timeout, getStatus genuinely never throws (returns OFFLINE on any failure), the Moonraker print=true flag is correctly a multipart form field (klipper.js:88), OctoPrint's FINISHED heuristic is safely gated by the poller's transition+active-job logic, API keys never appear in logs (only err.message is logged on upload retry), and Klipper correctly maps user cancel to STOPPED. The Elegoo pair is where the risk lives: elegoo-centauri.js (SDCP) has no timeout on any operation and, because AutoReconnect is enabled, a connect to an unreachable printer never rejects - one dead CC1 hangs every poll tick's Promise.allSettled, so pollComplete never fires and the startup idle sweep (index.js:101) never dispatches to any printer, while leaking a new auto-reconnecting client every 15 s. Both Elegoo drivers also map user-stopped prints to FINISHED, and since scheduler._handleFinished credits completed_qty immediately on the transition (scheduler.js:477) - not at operator confirmation - stopping a failing print on the printer screen silently credits a full plate of good parts, the same inventory-corruption class as the documented phantom-credit bug. elegoo-centauri2.js (MQTT) is much better engineered (bounded waits everywhere, no credential logging) apart from sharing the stopped→FINISHED mapping and buffering whole files in memory for upload.

**deploy-ci**: The deploy/CI subsystem is in noticeably good shape for a hobby-origin project: multi-stage Dockerfile with prod-pruned deps and correct patch-package handling, named volumes for the SQLite DB and gcode store, a lockfile-driven CI with tests gating publish, minimal GITHUB_TOKEN permissions, and dependency versions that are current and free of the obvious CVE classes (express 4.22.2, multer 2.2.0, mqtt 5.15.1, basic-ftp 5.3.1, axios 1.16.0, ws 8.21.0 per package-lock.json). The DB cannot be lost by update.bat since server/data is gitignored and migrations run at server start, so no migration-skip path exists. The real weaknesses are operational: the container runs as root with no healthcheck, the Windows update script masks failed npm installs and can force-kill unrelated processes matching port 3000 in netstat output, and the upstream registry only guarantees mutable tags (:latest, nightly-rebuilt :edge) - the fork must pin a semver tag or digest. The sdcp dependency is a niche, effectively unmaintained package (0.5.4) kept viable by a local patch-package patch that strips a debug dump of the whole printer object from logs.

**test-coverage**: The suite is well-crafted overall: consistent idioms (in-memory better-sqlite3 with schema declared inline per suite, supertest against route factories `require('../routes/x')(db)`, jest.mock of transports - axios/mqtt/basic-ftp/sdcp - plus mocked ../drivers and ../notifications, fake timers for retry delays, unique printer IDs to dodge module-level driver connection caches, and jest.resetModules() for module-scope routers), no .skip/.only anywhere, and strong regression suites for backup/restore and the scheduler unit surface. Against the fork's risk list: (1) double dispatch - covered at unit level (scheduler-sweep.test.js sweep lock/pending queue; scheduler-file.test.js upload lock + stale-job grace window); (2) no dispatch to held printers - UNCOVERED (hold-setting is tested, but no test that scheduler.js:190's is_held re-read refuses dispatch, and sweepIdlePrinters' WHERE clause is never tested); (3) restart mid-print - partial (set-ready missed-finish tests only, via a replica route; initial-poll gating untested); (4) stale-status replay - covered (scheduler-finished.test.js session gating + set-ready stale-failed test); (5) offline mid-job - partial (set-ready Case 5, but the real handler's OFFLINE no-credit branch is untested and a seed-helper bug means printer status is never actually OFFLINE/IDLE); (6) priority/targeting - covered (projects-reorder.test.js via a duplicated SQL copy, scheduler-targeting.test.js via real dispatch); (7) crash between job INSERT and upload - partial (orphaned 'uploading' job resolution tested only through endpoints, no restart-recovery test); (8) UPLOAD_CONFLICT - partial (drivers throwing it is tested in prusa/octoprint suites; the scheduler's conflict wait path at scheduler.js:380 is untested); (9) backup/restore - covered thoroughly (backup-restore.test.js incl. FK order, older backups, NOT NULL defaults, path traversal); (10) set-ready crediting - partial: single endpoint heavily tested but against a hand-copied replica that has rotted (see findings), and the batch endpoint is entirely untested. The one genuinely serious problem is that set-ready.test.js - the suite guarding the credit-exactly-once invariant - no longer tests the production handler and asserts behavior the current code does not have.

**client-leak**: The client is a clean, dependency-light React SPA: no dangerouslySetInnerHTML anywhere, all user-controlled strings render through JSX text nodes, localStorage holds only UI preferences (collapsed groups, show-decommissioned flag in Printers.jsx), and there is no SSE/EventSource - everything is 15s fetch polling. Toast/error paths only surface the server's `error` field, not whole response bodies. The material findings all concern printer credentials: the client actively fetches, renders, and round-trips printer api_key/access codes in two flows (PrinterDetail edit form, CSV-import flagged rows), which is both a live credential exposure to any LAN browser and a hard dependency the upcoming redaction PR must break. Secondary friction for the auth PR: the backup export is a bare window.location navigation, the gcode upload is a raw XMLHttpRequest, and there is no shared API client - roughly 60 bare fetch() call sites would each need auth handling if header-based auth is chosen (cookie-based auth would avoid this).

