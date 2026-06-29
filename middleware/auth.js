'use strict';

const jwt = require('jsonwebtoken');

/**
 * Express auth middleware.
 * Expects a Bearer token in the Authorization header:
 *   Authorization: Bearer <token>
 *
 * Verifies it against process.env.JWT_SECRET (already configured in
 * Vercel). On success, attaches the decoded token payload to req.user
 * and calls next(). On failure, responds with 401 and does NOT call next().
 */
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Missing or malformed Authorization header' });
  }

  if (!process.env.JWT_SECRET) {
    // Fail safely rather than silently accepting any token if the secret
    // somehow isn't configured in this environment.
    console.error('[auth middleware] JWT_SECRET is not set');
    return res.status(500).json({ message: 'Server auth misconfiguration' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = auth;
