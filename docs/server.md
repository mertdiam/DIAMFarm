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

1. `db.js` is `require()`d — this synchronously creates `server/data/` and `server/gcode/` if missing, opens the SQLite database, and runs all `CREATE TABLE IF NOT EXISTS` statements.
2. All route modules are instantiated with the `db` instance injected.
3. Express app is configured with `express.json()` and route mounting.
4. `app.listen()` binds to the port.
5. Inside the listen callback, `PrinterPoller` and `JobScheduler` are instantiated. `scheduler.start()` is called first (subscribes to poller events), then `poller.start()` fires the first poll tick and starts the 15-second interval.
6. The startup sweep (`sweepIdlePrinters`) is deferred until the poller emits `pollComplete` after its first tick. This ensures dispatch works from live printer state rather than stale DB values from before the last shutdown — preventing accidental dispatch to a printer that started printing while the server was down.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express listening port — override with `process.env.PORT` |

No `.env` file is required. The only runtime configuration is `PORT`.

## Route Mounting

```
GET    /api/health                  → health check (inline handler)
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
| `yauzl` | 3.4.0 | Random-access ZIP entry reads for the 3MF header parser (pinned exact, pure JS, no native build) |
| `concurrently` | ^8.2.2 | Runs server + client together via `npm run dev` |

## G-code header metadata (`header_meta`)

`server/lib/headerParser.js` exports one async function, `parseHeader(filePath)`, which extracts slicer metadata from an uploaded G-code or 3MF file. `server/routes/gcodes.js` calls it on upload and stores the JSON result in the additive `gcodes.header_meta` column; G-code responses expose it as a parsed object (or `null`).

Key properties:

- **Never blocks or fails an upload.** Any read error, unrecognized format, or missing field yields a null-filled result plus a `warnings` note; the upload proceeds regardless. The route also wraps the call so a thrown exception is treated the same as a null result.
- **Never reads a whole file.** It sniffs the first 8 bytes (`PK\x03\x04` for 3MF, `GCDE` for binary G-code, otherwise ASCII), reads the first and last 512 KB of ASCII G-code, and for 3MF opens only the named ZIP entries it needs via `yauzl`.
- **Flat, fully-shaped result.** Every key is always present: `format`, `slicer`, `slicer_version`, `printer_model`, `printer_model_id`, `nozzle_diameters`, `filament_types`, `filament_colors`, `estimated_time_s`, `layer_height_mm`, `total_layers`, `filament_used_g`, `filament_used_mm`, `warnings`. Scalars default to `null`, lists to `[]`. Times are whole seconds; 3MF filament usage is converted from meters to millimeters.

Formats covered: Bambu Studio and OrcaSlicer G-code (BBL and non-BBL targets), PrusaSlicer G-code, sliced and unsliced Bambu 3MF, PrusaSlicer 3MF config, binary G-code (detected only), and third-party or stripped files (null-filled). The full extraction contract lives in `docs/internal/header-parser-spec.md` (fork-internal, not part of the public docs index).

Hardware-validation status: implemented from verified format research and tested against synthetic fixtures only. Real sliced files must be collected before the output is trusted against real hardware.
