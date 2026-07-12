# Server

## Purpose

`server/index.js` is the Express entry point. It wires together the database, all route handlers, and the polling loop into a single process that starts with `npm run server`.

## Key Files

| File | Responsibility |
|---|---|
| `server/index.js` | App setup, route mounting, server start, poller + scheduler init |
| `server/db.js` | SQLite connection, schema creation, directory setup |
| `server/poller.js` | Printer status polling loop |
| `server/scheduler.js` | Job dispatch engine — listens to poller events, dispatches prints |
| `server/notifications.js` | In-memory alert store for recoverable server errors |
| `server/routes/` | One file per resource (printers, projects, parts, gcodes, jobs, backup) |
| `server/data/farm.db` | SQLite database file (auto-created, gitignored) |
| `server/gcode/` | G-code file storage directory (auto-created, gitignored) |

## Startup Sequence

1. `db.js` is `require()`d, which synchronously creates `server/data/` and `server/gcode/` if missing, opens the SQLite database, and runs all `CREATE TABLE IF NOT EXISTS` statements (including the Better Auth tables: user, session, account, verification).
2. All route modules are instantiated with the `db` instance injected.
3. An async bootstrap `(async () => { ... })()` dynamic-imports the ESM-only Better Auth instance from `server/auth.mjs`. Everything below runs inside it because it depends on that instance.
4. Middleware order matters and is fixed: the auth handler is mounted at `/api/auth/*` BEFORE `express.json()` (the body parser would otherwise consume the request stream the auth handler needs, hanging sign-in); then `express.json()`; then the public `/api/health`; then `require-auth` on all other `/api/*`; then the admin-only gate table; then the route mounts.
5. `app.listen()` binds to the port.
6. Inside the listen callback, `PrinterPoller` and `JobScheduler` are instantiated. `scheduler.start()` is called first (subscribes to poller events), then `poller.start()` fires the first poll tick and starts the 15-second interval.
7. The startup sweep (`sweepIdlePrinters`) is deferred until the poller emits `pollComplete` after its first tick. This ensures dispatch works from live printer state rather than stale DB values from before the last shutdown, preventing accidental dispatch to a printer that started printing while the server was down.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express listening port — override with `process.env.PORT` |
| `BETTER_AUTH_SECRET` | (none) | Better Auth signing secret. Required in production. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Base URL of the deployment. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | the base URL | Comma-separated origins allowed to POST (CSRF). Add every LAN origin operators use. |

Auth env vars and the first-admin seed step are documented in docs/installation.md and docs/api.md.

## Route Mounting

```
POST   /api/auth/*                  → Better Auth handler (mounted before express.json())
GET    /api/health                  → health check (inline handler, public)
POST   /api/scheduler/dispatch      → scheduler.sweepIdlePrinters() (inline handler)
GET    /api/notifications           → notifications.list() (inline handler)
DELETE /api/notifications/:id       → notifications.dismiss() (inline handler)
*      /api/printers                → server/routes/printers.js
*      /api/projects                → server/routes/projects.js
*      /api/parts                   → server/routes/parts.js
*      /api/gcodes                  → server/routes/gcodes.js
*      /api/jobs                    → server/routes/jobs.js
*      /api/backup                  → server/routes/backup.js
```

All route modules export a factory function `(db) => router`. This passes the shared synchronous `better-sqlite3` instance into each router without any global state.

## Route Factory Pattern

Every route file follows the same pattern:

```js
module.exports = (db) => {
  const router = express.Router();
  // ... route definitions using db ...
  return router;
};
```

And is mounted in `index.js` as:

```js
const printersRouter = require('./routes/printers')(db);
app.use('/api/printers', printersRouter);
```

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.19.2 | HTTP server and routing |
| `better-sqlite3` | ^9.6.0 | Synchronous SQLite driver |
| `multer` | ^2.1.1 | Multipart file upload handling (CSV import + G-code upload) |
| `papaparse` | ^5.4.1 | CSV parsing for printer import |
| `axios` | ^1.7.2 | HTTP client for PrusaLink API calls |
| `form-data` | ^4.0.0 | Multipart form construction for G-code uploads to PrusaLink |
| `concurrently` | ^8.2.2 | Runs server + client together via `npm run dev` |
