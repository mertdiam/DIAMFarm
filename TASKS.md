# TASKS.md - Task Briefs + Operating Guide

## PART A - HOW TO USE THIS FILE (read first)

### Setup (one time, human does this)

1. Fork, clone, add upstream remote (PLAN.md §2).
2. Copy `PLAN.md` and this `TASKS.md` into repo root, commit to your `production` branch.
3. Open the repo's existing `CLAUDE.md` and append this block at the bottom:

```markdown
## Internal Fork Rules (see PLAN.md + TASKS.md)
- This is an internal fork. Read PLAN.md before any work.
- Only work from a task brief in TASKS.md. If no brief covers the request, stop and say so.
- Never touch server/scheduler.js, server/db.js, server/drivers/* unless the brief names them.
- Run npm test before every commit. Failing tests block commits.
- Append every significant decision to the Decisions Log below.

## Decisions Log
- [DATE] Forked upstream at commit <hash>. Bambu-only launch scope. Klipper path deferred (accepted risk).
```

4. For each task, start a **fresh Claude Code session** (clean context = cheaper and sharper) and paste the single brief, nothing more. Claude Code reads `CLAUDE.md` automatically and will pull `PLAN.md` per the rules above.

### Running a brief (per-task loop)

1. `git worktree add ../pfm-task-N feature/task-N` - one worktree per task, max 2-3 parallel.
2. Start Claude Code in that worktree with the assigned model tier (see each brief's header).
3. Paste the brief verbatim. First instruction is always: *"Write the failing acceptance tests first, show me they fail, then implement."*
4. Accept only when tests pass. Then run the review step listed in the brief.
5. Small PR, CI green, human merge. Delete worktree.

### Escalation ladder (applies to every brief)

Bulk tier: 2 test-verified attempts max → hand failed diffs + test output to Workhorse → 2 attempts → hand everything to Architect tier. **Never** let a model retry in a loop past its budget. Each escalation starts a fresh session containing: the brief, the failing tests, the failed diffs - nothing else.

### Token budget guide (approximate, per task)

| Task | Tier | Sessions | Rough budget |
|---|---|---|---|
| T0 Audit | Architect | 2-3 | High - this is where top-tier spend belongs |
| T1 Scheduler tests | Architect | 2 | High |
| T2 Better Auth | Workhorse + cross-review | 2-3 | Medium |
| T3 Credential redaction | Workhorse | 1 | Low |
| T4 Header parser spec | Architect | 1 | Low-medium |
| T4 Header parser impl | Bulk | 1-2 | Low |
| Phase 2 items | Bulk from Workhorse specs | 1 each | Low |

Expected overall split lands near the agreed 5-10% architect / 25-30% workhorse / 60-70% bulk - most *tasks* by count go to cheap models, most *risk* goes to expensive ones.

---

## PART B - THE BRIEFS

---

### TASK 0a - Codebase & Security Audit

**Tier:** Architect (Opus / GPT-5-class). Human reads the output in full.
**Phase:** 0. **Blocks:** everything.

**Goal:** Produce `docs/internal/audit-findings.md` - an evidence-based read of whether this codebase is safe to build on.

**Files in scope (read-only - this task changes NOTHING):**
`server/scheduler.js`, `server/poller.js`, `server/db.js`, `server/index.js`, all of `server/drivers/`, all upload/file-serving routes, backup/restore code, `Dockerfile`, `docker-compose*.yml`, existing tests, `.github/workflows/`.

**Prompt to paste after the brief:**
"For each file: summarize what it does, then check specifically for - duplicate-dispatch protection, DB transaction boundaries, restart recovery behavior, path traversal or unrestricted upload, printer credentials leaking in API responses, missing command timeouts/retries, states where a job can get permanently stuck, backup consistency, migration/rollback behavior. Rate each finding Critical / Should-fix / Note. End with a go/no-go recommendation against the criteria in PLAN.md §3c."

**Acceptance:** `audit-findings.md` exists, every scoped file covered, every finding has file+line reference, go/no-go section present.

**Do NOT:** modify any code, "fix things while you're in there," or propose refactors. Findings only.

---

### TASK 0b - Bambu Hardware Validation

**Tier:** Human-driven. Workhorse (Sonnet) assists only with writing up the matrix document.
**Phase:** 0. **Blocks:** go/no-go.

**Goal:** `docs/internal/capability-matrix.md` covering one X1C/P1S (control), one P2S, one H2D on the unmodified app, isolated VLAN.

**Test grid per printer:** status/temps · file upload · start/pause/resume/cancel · completion detection · sign-off-before-redispatch · AMS/material info · app restart mid-print · printer power cycle · network interruption · IP change · bad credentials · failed file transfer. Record pass/fail/partial + firmware version + notes. Short sacrificial prints only.

**LLM use:** paste raw notes to Sonnet, have it produce the clean matrix doc and a delta list ("what P2S/H2D need patched"). That delta list becomes input to Task T5 if non-empty.

**Then:** human records go/no-go in `CLAUDE.md` Decisions Log, including the accepted deferred-Klipper risk. **If no-go, stop here - no further briefs run.**

---

### TASK 1 - Scheduler + Restart-Recovery Test Suite (PR 1)

**Tier:** Architect writes tests. Human review mandatory. **This is the one task where the expensive model writes code directly** - these tests are the safety net every later task depends on.
**Phase:** 1. **Blocks:** T2, T3, T4, T5.

**Goal:** Lock in the scheduler's current *correct* behavior with tests before anything else changes.

**Files in scope:** NEW test files only - `server/tests/scheduler.test.js`, `server/tests/recovery.test.js`, plus mock/fixture helpers under `server/tests/helpers/`. Mock the drivers; no hardware needed.

**Must cover at minimum:**
- A job dispatches exactly once even under concurrent poll ticks (the double-dispatch case).
- A completed job never auto-redispatches before human sign-off.
- App restart mid-print: job resumes tracking, is not lost, is not duplicated.
- Printer going offline mid-job → job enters a recoverable state, not a stuck one.
- Queue ordering respected; incompatible printer never receives a job.
- DB transactions: a crash between "mark dispatched" and "send to printer" doesn't orphan state (test whichever order the code actually uses - the audit will have told you).

**Acceptance:** suite runs in CI via `npm test`, all green against unmodified code. Any test that FAILS against unmodified code is a real upstream bug - file it in `audit-findings.md` and flag to human before proceeding.

**Do NOT:** modify `scheduler.js`, `db.js`, `poller.js`, or any driver. If a test can't be written without a refactor, report that instead of refactoring.

---

### TASK 2 - Better Auth Integration (PR 2)

**Tier:** Workhorse (Sonnet) implements. **Cross-family review:** full diff reviewed by a GPT/Gemini-class model in a separate session, then human. Non-negotiable.
**Phase:** 1. **Depends on:** T1 merged.

**Goal:** Session auth + Admin/Operator roles via Better Auth, per PLAN.md §4.

**First instruction to the model:** "Fetch and read the current Better Auth docs at better-auth.com before writing anything. Do not trust remembered API names - the library moves fast and training data is stale."

**Files in scope:**
- NEW: `server/auth.js` (Better Auth config), `server/middleware/requireAuth.js`, `server/middleware/requireRole.js`, `client/src/pages/Login.jsx`, `client/src/pages/admin/Users.jsx`, `client/src/lib/authClient.js`
- MODIFY (minimally): `server/index.js` (mount `/api/auth/*` handler + apply middleware globally), React router file (login route + guards), `package.json` (pin exact Better Auth version - no `^`)

**Spec:**
- Same SQLite file as the app (better-sqlite3/Kysely adapter) so backup/restore covers auth tables. Run migration CLI; commit generated schema.
- Email/password only. Public sign-up disabled. Admin creates accounts. Seed script for first admin (credentials from env vars, never hardcoded).
- Roles: `admin` (printer CRUD, user management, overrides) and `operator` (upload, queue, confirm bed-clear).
- All `/api/*` protected except `/api/auth/*` and health check. Admin-only routes wrapped with `requireRole('admin')`.
- JSDoc types on new modules. No TS conversion of existing files.

**Acceptance tests (write first, failing):**
- Unauthenticated request to any protected route → 401.
- Operator hitting admin route → 403.
- Login → session cookie → protected route succeeds.
- Sign-up endpoint disabled/404 for public.
- Full existing test suite (incl. T1 scheduler tests) still green.

**Do NOT:** touch `scheduler.js`, `db.js` (Better Auth manages its own tables via its adapter), drivers, or restructure existing routes beyond adding middleware.

---

### TASK 3 - Credential Redaction (PR 3)

**Tier:** Workhorse. Human review.
**Phase:** 1. **Depends on:** T2 merged (auth exists, so redaction can't be bypassed).

**Goal:** Printer access codes / API keys never reach any client, any role, ever.

**Files in scope:** printer route handlers and any serializer returning printer objects; NEW `server/tests/redaction.test.js`. The audit (T0a) will have listed exact leak points - work from that list.

**Spec:** strip/omit credential fields from every API response including admin ones (admin *sets* credentials via write endpoints, never reads them back - return masked `"•••set"` indicator only). Grep the client code for any place expecting those fields and remove.

**Acceptance tests:** every printer-returning endpoint asserted to contain no credential fields, as both roles; setting credentials still works; full suite green.

**Do NOT:** change how credentials are stored in the DB in this PR (encryption-at-rest is a separate later task if the audit demands it), touch drivers' internal use of credentials.

---

### TASK 4 - G-code/3MF Header Parser (PR 4, two stages)

**Stage 1 - Spec. Tier:** Architect, one session.
Human collects 3-5 real sliced files per slicer (Bambu Studio, OrcaSlicer, PrusaSlicer - at minimum the Bambu ones) and commits them to `server/tests/fixtures/gcode/`. Architect model reads the raw files and writes `docs/internal/header-parser-spec.md`: exact fields (printer model, nozzle, material, estimated time), exact header keys/patterns per slicer, 3MF-vs-gcode handling, fallback behavior when fields missing.

**Stage 2 - Implementation. Tier:** Bulk (Haiku/Flash) against the spec. Workhorse reviews the diff. Human merges.

**Files in scope:** NEW `server/lib/headerParser.js`, `server/tests/headerParser.test.js`; MODIFY the upload route only to call the parser and attach results to the job record; small UI change to display detected metadata on upload.

**Acceptance tests:** one test per fixture file asserting exact extracted values; graceful null-fill on a fixture with stripped headers; upload flow works unchanged when parsing fails (parser must never block an upload); full suite green.

**Do NOT:** auto-assign jobs to printers based on parsed data in this PR (detection only - auto-matching is a follow-up brief once trust is established), touch scheduler or drivers.

---

### TASK 5 - P2S/H2D Driver Patches (conditional PR)

**Runs only if** Task 0b's delta list is non-empty.
**Tier:** Architect only. Human review + real-hardware retest of the full 0b grid for affected machines. This is driver code - the strictest rules apply.

**Files in scope:** the specific Bambu driver files named by the delta list, nothing else. Each patch gets a regression test with mocked MQTT/FTPS responses captured from the real machines.

**Do NOT:** refactor the driver beyond the minimal patch; touch other brands' drivers. Offer each patch upstream as a PR after it's proven on your hardware.

---

### PHASE 2 BRIEFS (run after Phase 1 ships to the team)

Written the same way; summarized here so the pipeline is visible:

- **T6 Quantity tracking verify/extend** - Workhorse audits existing projects/parts depth vs. your target/completed needs, writes spec; Bulk implements if gaps exist.
- **T7 Audit log** - Workhorse spec (append-only events table: who/what/when for cancel/override/confirm), Bulk implements table + middleware hook + simple viewer page. May touch a migration → that single migration file gets Architect review per the hard rules.
- **T8 CSV history export** - Bulk, single session, trivial.
- **T9 Notification hooks** - Workhorse spec (webhook on finish/error, email optional), Bulk implements.

When Phase 2 starts, expand these into full file-scoped briefs using T2-T4 above as the template - that expansion itself is a good Workhorse task.

---

## PART C - STANDING RULES REMINDER (paste-safe summary for any session)

1. Tests are the contract. Failing tests first. "Looks right" is never acceptance.
2. Drivers/scheduler/DB migrations = Architect + human only. Auth + printer-command paths = cross-family review + human.
3. 2 attempts per tier, then escalate with failed diffs + test output in a fresh session.
4. One brief per session, one feature per PR, worktrees for parallelism.
5. Keep `CLAUDE.md` Decisions Log current - it's the cheapest token saver you have.
6. Node 22 LTS, SQLite stays, no TS conversion of existing files, MIT `LICENSE` preserved, verify external docs links before trusting them.
