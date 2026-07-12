// Seed the first admin account.
//
// Run once per install, after the server has created its tables (any server start, or the
// db.js import below, creates them). Credentials come from the environment, never hardcoded:
//
//   SEED_ADMIN_EMAIL=admin@example.com \
//   SEED_ADMIN_PASSWORD='a-strong-password' \
//   SEED_ADMIN_NAME='Farm Admin' \
//   BETTER_AUTH_SECRET=... \
//   node scripts/seed-admin.mjs
//
// Public sign-up is disabled, so this admin-side path (auth.api.createUser called with NO
// request headers, which skips the acting-admin check) is how the first account is created.
// Subsequent users are created by an admin through the Users page in the app.
//
// The script refuses to run if the email already exists, so re-running it is safe and never
// overwrites or re-credentials an existing account. It prints no password.

import { auth } from '../server/auth.mjs';
import db from '../server/db.js';

const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
const name = process.env.SEED_ADMIN_NAME || 'Farm Admin';

function fail(msg) {
  console.error('[seed-admin] ' + msg);
  process.exit(1);
}

if (!email || !password) {
  fail('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required.');
}

const existing = db.prepare('SELECT id FROM "user" WHERE email = ?').get(email);
if (existing) {
  fail('An account with that email already exists. Refusing to modify it.');
}

try {
  await auth.api.createUser({
    body: {
      email,
      password,
      name,
      role: 'admin',
    },
  });
  console.log('[seed-admin] Admin account created for ' + email + '.');
  process.exit(0);
} catch (err) {
  fail('Failed to create admin: ' + (err?.message || err));
}
