# PLAN.md: Print Farm Manager (Internal Fork), Final Scope v2

## 0. Mission and Decision

Fork `joeltelling/print-farm-manager` (MIT) and extend it for internal use: ~10 users, one LAN, **Bambu-only at launch** (X1C/P1S as known-good control, P2S and H2D to prove). Creality K2 Plus, OrangeStorm Giga, OctoPrint, Prusa, and Elegoo-native paths are deferred to Phase 4.

Do **not** build from scratch. Do **not** migrate to Postgres/Redis/NestJS/TypeScript: Express + better-sqlite3 + React/Vite is correct for this scale. The fork is **conditional on passing Phase 0** (evidence-based validation, not a formality).

**License obligation:** MIT permits private modification and internal use, but the original copyright and license notice must remain in all copies and substantial portions. Keep `LICENSE` and headers intact.

## 1. Links and Resources

**Core:**
- Upstream repo: `https://github.com/joeltelling/print-farm-manager`
- Published image: `ghcr.io/joeltelling/print-farm-manager`. **Pin to a version tag (e.g. `:1.0.0`); never auto-deploy `:latest`/`:edge`**
- In-repo docs to read first: `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/`
- Runtime: **Node.js 22 LTS** (Node 24+ has native SQLite compile issues on Windows)

**Launch-phase protocol references:**
- Bambu LAN protocol (community-documented): `https://github.com/Doridian/OpenBambuAPI` (MQTT topics, FTPS, Developer Mode / LAN-only behavior)
- Better Auth: `https://www.better-auth.com`. **Claude Code must read current docs before implementing; API surface changes fast**

**Deferred to Phase 4 (verify still current when needed):**
- Moonraker API: `https://moonraker.readthedocs.io`
- K2 Plus rooting: `https://github.com/jamincollins/k2-improvements`
- Giga conversion: `https://github.com/jpcurti/OpenOrangeStorm`
- OctoPrint REST API: `https://docs.octoprint.org/en/master/api/`
- PrusaLink: `https://github.com/prusa3d/Prusa-Link-Web`

**Agentic tooling:**
- Claude Code docs (memory files, worktrees, headless usage): `https://docs.anthropic.com/en/docs/claude-code`
- The repo ships `CLAUDE.md` and `.claude/skills/`: extend, don't replace.

## 2. Repo and Git Strategy

1. Fork on GitHub; clone; `git remote add upstream https://github.com/joeltelling/print-farm-manager.git`
2. Branches: `main` tracks upstream; `production` is deployed; feature branches per task, merged via small PRs.
3. CI is the gatekeeper: extend existing test suite (`npm test`); no merges with failing tests.
4. Periodically cherry-pick upstream driver fixes; contribute generic fixes (P2S/H2D patches, header parser) upstream to reduce divergence.
5. Production deploys pinned to a tested commit/tag of `production`.

## 3. Phase 0: Validation Gate (Week 1, ~2 max)

Run the **unmodified** app on an isolated printer VLAN or test network. No auth changes yet: a clean baseline keeps upstream defects visible.

**3a. Code + security audit** (top-tier model + human), full codebase, including drivers we aren't deploying yet:
`server/scheduler.js`, `server/poller.js`, `server/db.js`, `server/index.js`, all of `server/drivers/`, upload/file-serving routes, backup/restore, Dockerfile, tests, `.github/workflows`. Check specifically: duplicate-dispatch protection, transaction boundaries, restart recovery, path traversal / unrestricted uploads, credentials leaking via API responses, command timeouts/retries, stuck-job states, backup consistency, migration behavior. Output: `docs/internal/audit-findings.md`.

**3b. Hardware validation, Bambu only:** one X1C/P1S (control), one P2S, one H2D. Per printer: status/temps, file upload, start/pause/resume/cancel, completion detection, sign-off-before-redispatch, AMS/material info, app restart mid-print, printer power cycle, network interruption, IP change, bad credentials, failed file transfer. Short sacrificial prints only. Output: `docs/internal/capability-matrix.md`.

**3c. Go/no-go criteria:**
- **Fork and keep** if: all Bambu models monitor + control reliably; scheduler never double-dispatches; restart recovery doesn't lose/duplicate jobs; security defects are repairable without redesign; team can understand core modules; scheduler/drivers are testable.
- **Reference only (rebuild)** if: scheduler state is fundamentally unreliable; drivers are tightly coupled to UI/DB; recovery needs manual DB surgery; credentials can't be secured without rewriting most routes.

Record the decision, including the consciously accepted risk that the Klipper path is unvalidated at commit time, in the `CLAUDE.md` decisions log.

## 4. Phase 1: Security + Missing Core (Weeks 2-5)

Priority order:

**1. Better Auth integration** (replaces hand-rolled sessions):
- Mount Better Auth's handler on `/api/auth/*` via its Node adapter in `server/index.js`.
- Point it at the **same SQLite file** the app uses (better-sqlite3/Kysely adapter) so existing backup/restore covers auth tables free. Run its migration CLI; commit the schema.
- Email/password only. **Public sign-up disabled**: Admin creates accounts. No OAuth, no email verification.
- Admin plugin, two roles: `admin` (printer CRUD, user management, overrides) and `operator` (upload, queue, confirm bed-clear).
- One middleware resolving sessions and rejecting unauthenticated requests; a `requireRole('admin')` wrapper. Applied to all `/api/*` except `/api/auth/*` and health checks.
- Better Auth client library in React: login page + admin-only user-management page.
- New modules only (`server/auth.js`, middleware). JSDoc types fine; no TS conversion of existing files.
- **Pin the Better Auth version; no auto-upgrades.** Cross-family + human review mandatory despite using a library.

**2. Credential redaction:** printer access codes never returned to clients; isolated/encrypted at rest.

**3. Scheduler + restart-recovery test suite:** lock in correct behavior before touching anything else. (This is actually PR 1, before auth; see checklist.)

**4. P2S/H2D driver patches:** whatever the capability matrix surfaced. Top tier only, real hardware tested.

**5. G-code/3MF header parser:** auto-detect printer model, nozzle, material, estimated time from Bambu Studio / OrcaSlicer / PrusaSlicer output. Top tier writes the extraction spec from real sliced files; bulk tier implements against committed fixtures (`server/tests/fixtures/gcode/`).

Everything must stay **driver-agnostic**: no Bambu assumptions hardcoded in ways that break re-enabling Klipper later. Ship to the team at end of Phase 1.

## 5. Phase 2: Production Tracking (Weeks 5-9)

- Verify/extend quantity tracking (target vs. completed per part; repo has projects/parts, confirm depth).
- Audit log: append-only events table (who cancelled/overrode/confirmed) + simple viewer.
- Print history CSV export.
- Notification hooks (webhook and/or email on finish/error).

Mostly bulk-tier work against workhorse-written specs.

## 6. Phase 3: Only If Real Usage Demands

Rack/physical layout view, loaded-filament tracking, spool inventory, nozzle life, maintenance flags. Decide from pain, not spec. Note: filament/spool tracking is a parked feature upstream; coordinate before building.

## 7. Phase 4: Additional Printer Onboarding (when needed)

1. Root K2 Plus (`jamincollins/k2-improvements`, verify current), validate against existing Moonraker driver.
2. Convert Giga via OpenOrangeStorm, validate same driver.
3. Extend capability matrix; patch drivers only if the matrix demands.
4. OctoPrint/Prusa as fallback paths if the fleet needs them.

**Do not delete or modify the Klipper, OctoPrint, Prusa, or Elegoo drivers in the meantime**: untouched upstream code preserves clean cherry-picking.

## 8. Multi-LLM Routing and Token Management

| Tier | Models | Scope | ~Token share |
|---|---|---|---|
| Architect/Reviewer | Opus, GPT-5-class, Gemini Pro | Drivers, scheduler, DB migrations, auth security review, specs for lower tiers, escalated debugging | 5-10% |
| Workhorse | Sonnet, Codex mid | Feature implementation (auth, parser), multi-file refactors, integration tests, review of bulk output | 25-30% |
| Bulk | Haiku, Gemini Flash | CRUD, React components from spec, unit test scaffolding, CSV export, docs, chores | 60-70% |

**Hard rules:**
1. Drivers, scheduler, DB migrations: top tier + human review only.
2. Auth and anything sending printer commands: written by one model family, reviewed by another + human.
3. **Tests are the contract**: failing tests first; cheap output accepted when tests pass, never when it "looks right."
4. **Escalation ladder:** bulk gets 2 test-verified attempts, then workhorse (with failed attempts as context), then architect. Never let a cheap model loop.
5. **Context discipline:** keep `CLAUDE.md` + `ARCHITECTURE.md` current (conventions, fleet details, decisions log). Every task brief is file-scoped: exact files, acceptance test, what NOT to touch. Never paste the whole repo.
6. Git worktrees for 2-3 parallel agent sessions on independent tasks; merge via PR + CI.
7. Architect specs are reusable artifacts; debugging sessions are not.
8. Small PRs, one feature per PR.

## 9. Claude Code Guardrails

- Read `CLAUDE.md`, `ARCHITECTURE.md`, and this file before any change; append significant decisions to the decisions log.
- Never modify `server/scheduler.js`, `server/db.js`, or `server/drivers/*` without an explicit task brief naming those files.
- Never commit secrets; printer credentials live in DB/env only.
- Run `npm test` before every commit; add tests with every feature.
- Preserve the MIT `LICENSE` and notices.
- Node 22 LTS only; keep SQLite; no TS conversion of existing files (JSDoc on new modules is fine).
- Read current Better Auth docs before implementing. Do not trust remembered API names.
- Follow every upstream CLAUDE.md convention (dash rule, docs-with-change, changelog, test patterns). Fork rules add to them; they never override them.

## 10. First Actions Checklist

1. Fork + clone + add `upstream` remote.
2. `docker compose up -d`, pinned image, test VLAN; CSV-import **Bambu printers only**.
3. Full-codebase Phase 0 audit, output `docs/internal/audit-findings.md`.
4. Bambu-only hardware validation, output `docs/internal/capability-matrix.md`.
5. Go/no-go recorded in `CLAUDE.md`, including the deferred-Klipper risk note.
6. If go: **PR 1 = scheduler/recovery test suite; PR 2 = Better Auth; PR 3 = credential redaction; PR 4 = header parser.**

## 11. Standing Caveats

- Verify all external links are still current before relying on them; community projects move fast.
- Treat Phase 1 priorities as provisional until the Phase 0 capability matrix exists; its findings rewrite the task list.
