// Better Auth configuration (ESM).
//
// Better Auth is an ESM-only package and this server is CommonJS, so the auth
// instance lives in its own .mjs module. server/index.js loads it with a dynamic
// `await import('./auth.mjs')` inside its async bootstrap. Do not convert the rest
// of the server to ESM.
//
// The auth instance is pointed at the app's existing better-sqlite3 Database handle
// (imported from the CommonJS db.js via Node's ESM/CJS default interop, which returns
// the same cached singleton require('./db') hands the rest of the server). Better Auth
// uses its built-in Kysely adapter against that handle. The auth tables themselves
// (user, session, account, verification) are created by db.js in the house
// CREATE TABLE IF NOT EXISTS pattern, so no migration CLI runs at deploy time.
//
// Roles: two roles built from the admin plugin's access-control statements.
//   admin    - full user management (create/list/set-role/ban/delete users) plus the
//              app's admin-only endpoints (printer CRUD, settings, backup).
//   operator - day-to-day production (upload, queue, set-ready). No user management.
//
// LAN HTTP deployment: cookies are non-secure (advanced.useSecureCookies=false) because
// the farm runs over plain HTTP on a LAN. Every LAN origin that will POST must appear in
// BETTER_AUTH_TRUSTED_ORIGINS or Better Auth rejects the request as a CSRF failure.

import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, adminAc, userAc } from 'better-auth/plugins/admin/access';

import db from './db.js';

const baseURL = process.env.BETTER_AUTH_URL || 'http://localhost:3000';

// Fail fast on a missing signing secret. Better Auth only throws for this when
// NODE_ENV is 'production', and the Windows farm deployment (PM2, update.bat) does
// not reliably set NODE_ENV, so without this guard a forgotten env var means the
// server silently runs on a default signing key.
if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error(
    'BETTER_AUTH_SECRET is not set. Generate one with: npx auth@1.6.23 secret'
  );
}

// Trusted origins: comma-separated env list (wildcards like http://192.168.1.*:3000 are
// supported by Better Auth). Defaults to just the baseURL when unset, and also when the
// env var parses to an empty list (e.g. a value of only commas), which would otherwise
// silently reject every state-changing request as a CSRF failure.
let trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || baseURL)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (trustedOrigins.length === 0) trustedOrigins = [baseURL];

// Access control: operator inherits the admin plugin's userAc statements (no user-management
// verbs); admin inherits adminAc (full user management). Custom roles MUST be registered here
// or createUser / setRole reject an unknown role.
const ac = createAccessControl(defaultStatements);
const adminRole = ac.newRole(adminAc.statements);
const operatorRole = ac.newRole(userAc.statements);

/**
 * Build a Better Auth instance against a given better-sqlite3 Database. Extracted as a
 * builder so the smoke script and tests can inject an isolated temp database while sharing
 * the exact production config (roles, cookie rules, disabled sign-up). Production uses the
 * default export built from the app's db.js handle.
 */
export function buildAuth(database) {
  return betterAuth({
    database,
    baseURL,
    trustedOrigins,
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
      // Public sign-up is disabled: accounts are created only by an admin through the
      // admin plugin's createUser route (or the seed script). This also blocks the
      // server-side signUpEmail path.
      disableSignUp: true,
    },
    advanced: {
      // LAN HTTP: force non-secure cookies. With an http:// baseURL this would already
      // resolve non-secure, but we set it explicitly so a stray NODE_ENV=production does
      // not silently flip cookies to Secure and break login over plain HTTP.
      useSecureCookies: false,
    },
    session: {
      // Cache the session in a signed cookie for 5 minutes so the common per-request
      // getSession does not hit SQLite on every API call.
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    plugins: [
      admin({
        ac,
        roles: {
          admin: adminRole,
          operator: operatorRole,
        },
        defaultRole: 'operator',
        adminRoles: ['admin'],
      }),
    ],
  });
}

export const auth = buildAuth(db);

export default auth;
