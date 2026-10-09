const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TOKEN_EXPIRY = '30d';
const COOKIE_NAME = 'aura_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DUMMY_HASH =
  '$2b$12$sb/5YW2zGNXoO8yBkm/.dO4Jarf9iTeoUuemjIdPRO3xBCKpnRefy';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret.length < 32) {
      throw new Error(
        'JWT_SECRET must be configured in Render with at least 32 characters.'
      );
    }
    return secret;
  }

  if (!secret) {
    throw new Error(
      'JWT_SECRET is missing. Add it to your local .env file.'
    );
  }

  return secret;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(userId) {
  return jwt.sign(
    { sub: userId },
    getJwtSecret(),
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({
      error: 'Not signed in.'
    });
  }

  const payload = verifyToken(token);

  if (!payload || !payload.sub) {
    return res.status(401).json({
      error: 'Session expired. Please sign in again.'
    });
  }

  req.userId = payload.sub;
  next();
}

function requireXhrHeader(req, res, next) {
  if (req.get('X-Requested-With') !== 'AuraCosmos') {
    return res.status(403).json({
      error: 'Request rejected.'
    });
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
