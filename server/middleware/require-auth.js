/**
 * Session-resolving auth middleware.
 *
 * Factory that takes the Better Auth instance (loaded from the ESM auth.mjs in the
 * index.js bootstrap) and returns an Express middleware. The middleware resolves the
 * session from the request cookies via Better Auth's server API, attaches req.user and
 * req.session, and rejects unauthenticated requests with 401 JSON.
 *
 * Apply this to every /api/* route EXCEPT /api/auth/* (Better Auth's own handler, which
 * must be reachable to log in) and /api/health.
 *
 * @param {import('better-auth').Auth} auth - the Better Auth instance
 * @param {{ fromNodeHeaders: Function }} helpers - Better Auth node helpers (fromNodeHeaders),
 *   passed in because they live in the ESM 'better-auth/node' module the bootstrap imports.
 * @returns {import('express').RequestHandler}
 */
module.exports = (auth, { fromNodeHeaders }) => async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session || !session.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = session.user;
    req.session = session.session;
    next();
  } catch (err) {
    // getSession only throws on an internal failure, not on a missing/invalid session
    // (that returns null). Treat a throw as unauthenticated rather than 500 so a
    // transient decode error cannot be read as "authorized".
    console.error('[auth] getSession error:', err?.message || err);
    return res.status(401).json({ error: 'Authentication required' });
  }
};
