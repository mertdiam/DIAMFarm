/**
 * Role-gating middleware.
 *
 * Factory that returns an Express middleware asserting the authenticated user holds a
 * given role. Must run AFTER require-auth (it reads req.user, which require-auth attaches).
 *
 * Better Auth's admin plugin stores roles as a comma-joined string on user.role (a user
 * may hold several), so the check splits on commas rather than comparing the whole string.
 *
 * @param {string} role - required role, e.g. 'admin'
 * @returns {import('express').RequestHandler}
 */
module.exports = (role) => (req, res, next) => {
  const roles = (req.user?.role || '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!roles.includes(role)) {
    return res.status(403).json({ error: 'Forbidden: requires ' + role + ' role' });
  }
  next();
};
