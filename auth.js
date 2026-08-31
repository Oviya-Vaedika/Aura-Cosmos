const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let warnedNoSecret = false;
function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!warnedNoSecret) {
    console.warn(
      '\n[WARN] JWT_SECRET is not set in your environment.\n' +
      'Using a random secret generated for this process — all sessions will be\n' +
      'invalidated every time the server restarts. Set JWT_SECRET in .env for\n' +
      'real use (see .env.example).\n'
    );
    warnedNoSecret = true;
  }
  return getJwtSecret._ephemeral || (getJwtSecret._ephemeral = crypto.randomBytes(48).toString('hex'));
}

const TOKEN_EXPIRY = '30d';
const COOKIE_NAME = 'aura_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// A precomputed bcrypt hash of a random value, used only to burn roughly the
// same amount of time as a real password check when no account exists —
// see its use in the login route for why this matters.
const DUMMY_HASH = '$2b$12$sb/5YW2zGNXoO8yBkm/.dO4Jarf9iTeoUuemjIdPRO3xBCKpnRefy';

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (e) {
    return null;
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, // not readable from JS — mitigates XSS token theft
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/'
  });
}
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  const payload = verifyToken(token);
  if (!payload || !payload.sub) return res.status(401).json({ error: 'Session expired — please sign in again.' });
  req.userId = payload.sub;
  next();
}

// Light CSRF mitigation: our own frontend fetch calls always send this header.
// A plain cross-site <form> POST cannot set a custom header, so this blocks
// the simplest CSRF vectors even though the session cookie is sameSite=lax.
function requireXhrHeader(req, res, next) {
  if (req.get('X-Requested-With') !== 'AuraCosmos') {
    return res.status(403).json({ error: 'Request rejected.' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireXhrHeader,
  COOKIE_NAME,
  DUMMY_HASH
};
