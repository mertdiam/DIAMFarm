// Unit tests for the auth middleware factories.
//
// Better Auth is an ESM-only package and this repo's jest runs CommonJS without the
// experimental VM-modules flag, so a jest test cannot import the real auth instance. These
// tests therefore drive the require-auth / require-role FACTORIES against a stubbed
// auth.api.getSession, which is exactly the contract the middleware depends on: given a
// resolved session (or none), does the guard attach req.user, pass through, 401, or 403.
//
// The real Better Auth library (actual sign-in, cookie issuance, role storage, and the
// disabled public sign-up endpoint) is exercised end to end against a temp sqlite database
// by scripts/auth-smoke.mjs (npm run test:auth-smoke). Together they cover the full
// acceptance list: 401 without a session, 403 operator-vs-admin, pass-through with a valid
// session, and sign-up blocked.

const request = require('supertest');
const express = require('express');

const requireAuthFactory = require('../middleware/require-auth');
const requireRoleFactory = require('../middleware/require-role');

// Stub Better Auth: getSession returns whatever `nextSession` is set to for the next call.
// A thrown error is simulated by setting `throwNext`.
let nextSession;
let throwNext;
const auth = {
  api: {
    getSession: async () => {
      if (throwNext) {
        throwNext = false;
        throw new Error('simulated internal failure');
      }
      return nextSession;
    },
  },
};
// fromNodeHeaders is only forwarded to getSession; identity stub is enough here.
const helpers = { fromNodeHeaders: (h) => h };

function buildApp() {
  const requireAuth = requireAuthFactory(auth, helpers);
  const requireAdmin = requireRoleFactory('admin');

  const app = express();
  app.use(express.json());
  // Operator-level route: any authenticated user.
  app.get('/api/thing', requireAuth, (req, res) =>
    res.json({ userId: req.user.id, role: req.user.role, sessionId: req.session?.id })
  );
  // Admin-only route: authenticated AND admin.
  app.get('/api/admin/thing', requireAuth, requireAdmin, (req, res) => res.json({ ok: true }));
  return app;
}

let app;
beforeAll(() => { app = buildApp(); });
beforeEach(() => { nextSession = undefined; throwNext = false; });

describe('require-auth', () => {
  test('rejects with 401 when there is no session', async () => {
    nextSession = null;
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  test('rejects with 401 when getSession returns a session with no user', async () => {
    nextSession = { session: { id: 's1' }, user: null };
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(401);
  });

  test('passes through and attaches req.user / req.session with a valid session', async () => {
    nextSession = { session: { id: 'sess-1' }, user: { id: 'u1', role: 'operator' } };
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1', role: 'operator', sessionId: 'sess-1' });
  });

  test('treats a thrown getSession as unauthenticated (401), never authorized', async () => {
    throwNext = true;
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(401);
  });
});

describe('require-role', () => {
  test('403 when an operator hits an admin-only route', async () => {
    nextSession = { session: { id: 's' }, user: { id: 'u1', role: 'operator' } };
    const res = await request(app).get('/api/admin/thing');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/);
  });

  test('403 when the user has no role at all', async () => {
    nextSession = { session: { id: 's' }, user: { id: 'u1', role: null } };
    const res = await request(app).get('/api/admin/thing');
    expect(res.status).toBe(403);
  });

  test('200 when an admin hits an admin-only route', async () => {
    nextSession = { session: { id: 's' }, user: { id: 'u1', role: 'admin' } };
    const res = await request(app).get('/api/admin/thing');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('200 when a multi-role string contains admin (comma-joined roles)', async () => {
    nextSession = { session: { id: 's' }, user: { id: 'u1', role: 'operator,admin' } };
    const res = await request(app).get('/api/admin/thing');
    expect(res.status).toBe(200);
  });
});
