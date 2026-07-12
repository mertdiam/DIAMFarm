// End-to-end auth smoke test against a REAL Better Auth instance.
//
// The repo's jest runs in CommonJS and cannot import the ESM-only better-auth package
// without VM-modules flags, so this script covers the parts a jest unit test cannot: it
// boots the production auth config (buildAuth from server/auth.mjs) against a throwaway
// temp sqlite file, mounts it on a real Express server, and drives the full flow over HTTP
// with fetch:
//
//   create admin (server-side createUser) -> sign in -> cookie -> getSession -> role check
//   -> operator blocked from an admin-gated route (403) -> public sign-up disabled.
//
// Exits 0 only if every assertion passes; nonzero on the first failure. Wired as
// `npm run test:auth-smoke`. The jest suite server/tests/auth-middleware.test.js covers the
// middleware factories (401/403/attach) with a stubbed getSession; this proves the real
// library end to end.

import express from 'express';
import Database from 'better-sqlite3';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// A real secret before buildAuth runs (betterAuth reads it at build time).
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || 'smoke-test-secret-at-least-32-chars-long-xxxx';

const { buildAuth } = await import('../server/auth.mjs');
const requireAuthFactory = (await import('../server/middleware/require-auth.js')).default;
const requireRoleFactory = (await import('../server/middleware/require-role.js')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log('  ok   - ' + label);
  } else {
    console.error('  FAIL - ' + label);
    failures++;
  }
}

// Temp isolated database with the auth schema applied (same DDL the app ships in db.js,
// read from the committed reference file).
const tmpFile = path.join(os.tmpdir(), `auth-smoke-${Date.now()}.db`);
const db = new Database(tmpFile);
const schema = fs
  .readFileSync(path.join(__dirname, '..', 'docs', 'internal', 'better-auth-schema.sql'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
db.exec(schema);

const auth = buildAuth(db);
const requireAuth = requireAuthFactory(auth, { fromNodeHeaders });
const requireAdmin = requireRoleFactory('admin');

const app = express();
app.all('/api/auth/*', toNodeHandler(auth));
app.use(express.json());
app.get('/api/protected', requireAuth, (req, res) => res.json({ role: req.user.role }));
app.get('/api/admin-only', requireAuth, requireAdmin, (req, res) => res.json({ ok: true }));

const server = app.listen(0);
const port = server.address().port;
const base = `http://localhost:${port}`;

// Better Auth's CSRF protection rejects state-changing POSTs without an Origin header that
// matches a trusted origin. A real browser sends Origin automatically; node fetch does not,
// so we send the default trusted origin (the baseURL) explicitly on auth POSTs.
const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const jsonPost = (headers = {}) => ({ 'content-type': 'application/json', origin: ORIGIN, ...headers });

async function run() {
  // 1. Create the admin server-side (no headers -> skips acting-admin check).
  await auth.api.createUser({
    body: { email: 'admin@smoke.test', password: 'admin-password-123', name: 'Smoke Admin', role: 'admin' },
  });
  // and an operator.
  await auth.api.createUser({
    body: { email: 'op@smoke.test', password: 'operator-password-123', name: 'Smoke Operator', role: 'operator' },
  });
  check('createUser made two accounts', db.prepare('SELECT COUNT(*) c FROM "user"').get().c === 2);

  // 2. Unauthenticated protected request -> 401.
  const anon = await fetch(`${base}/api/protected`);
  check('unauthenticated protected route returns 401', anon.status === 401);

  // 3. Sign in as admin, capture cookie.
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: jsonPost(),
    body: JSON.stringify({ email: 'admin@smoke.test', password: 'admin-password-123' }),
  });
  check('admin sign-in returns 200', signIn.status === 200);
  const adminCookie = signIn.headers.get('set-cookie');
  check('admin sign-in sets a session cookie', !!adminCookie);
  check('session cookie is not Secure (LAN HTTP)', adminCookie && !/;\s*Secure/i.test(adminCookie));

  // 4. Protected route with the cookie -> 200 and admin role.
  const authed = await fetch(`${base}/api/protected`, { headers: { cookie: adminCookie } });
  const authedBody = await authed.json();
  check('admin reaches protected route', authed.status === 200);
  check('resolved role includes admin', (authedBody.role || '').split(',').includes('admin'));

  // 5. Admin reaches admin-only route.
  const adminRoute = await fetch(`${base}/api/admin-only`, { headers: { cookie: adminCookie } });
  check('admin reaches admin-only route', adminRoute.status === 200);

  // 6. Operator sign in, then blocked from admin-only route (403).
  const opSignIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: jsonPost(),
    body: JSON.stringify({ email: 'op@smoke.test', password: 'operator-password-123' }),
  });
  const opCookie = opSignIn.headers.get('set-cookie');
  check('operator sign-in returns 200', opSignIn.status === 200);
  const opProtected = await fetch(`${base}/api/protected`, { headers: { cookie: opCookie } });
  check('operator reaches operator-level protected route', opProtected.status === 200);
  const opAdminRoute = await fetch(`${base}/api/admin-only`, { headers: { cookie: opCookie } });
  check('operator blocked from admin-only route (403)', opAdminRoute.status === 403);

  // 7. Public sign-up disabled.
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: jsonPost(),
    body: JSON.stringify({ email: 'intruder@smoke.test', password: 'intruder-password-123', name: 'Intruder' }),
  });
  check('public sign-up is rejected (non-2xx)', signUp.status >= 400);
  check('sign-up did not create a third account', db.prepare('SELECT COUNT(*) c FROM "user"').get().c === 2);
}

try {
  await run();
} catch (err) {
  console.error('  FAIL - smoke run threw:', err?.message || err);
  failures++;
} finally {
  server.close();
  db.close();
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmpFile + ext); } catch (_) {} }
}

if (failures > 0) {
  console.error(`\n[auth-smoke] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[auth-smoke] all checks passed');
process.exit(0);
