
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./lib/db');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const UPSTREAM_TIMEOUT_MS = 40000;

if (!GEMINI_API_KEY) {
  console.warn('[WARN] GEMINI_API_KEY is missing. Dubis will be unavailable.');
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

/* ===========================================================
   RATE LIMITING
=========================================================== */

function createRateLimiter(maxRequests, windowMs) {
  const buckets = new Map();

  return function isLimited(key) {
    const now = Date.now();
    const recent = (buckets.get(key) || []).filter(
      timestamp => now - timestamp < windowMs
    );

    recent.push(now);
    buckets.set(key, recent);

    if (buckets.size > 5000) {
      for (const [ip, times] of buckets) {
        if (!times.some(timestamp => now - timestamp < windowMs)) {
          buckets.delete(ip);
        }
      }
    }

    return recent.length > maxRequests;
  };
}

const authLimiter = createRateLimiter(8, 60 * 1000);
const dubisLimiter = createRateLimiter(20, 60 * 1000);
const progressLimiter = createRateLimiter(60, 60 * 1000);
const avatarLimiter = createRateLimiter(20, 60 * 1000);

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/* ===========================================================
   VALIDATION
=========================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function isValidEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    EMAIL_RE.test(value);
}

function isValidUsername(value) {
  return typeof value === 'string' &&
    USERNAME_RE.test(value);
}

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 200 &&
    /[a-zA-Z]/.test(value) &&
    /[0-9]/.test(value);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar || 'cat',
    createdAt: user.createdAt
  };
}

function requireSameOriginRequest(req, res, next) {
  if (req.get('X-Requested-With') !== 'AuraCosmos') {
    return res.status(403).json({
      error: 'Request rejected.'
    });
  }

  next();
}

/* ===========================================================
   SIGN UP
=========================================================== */

app.post('/api/auth/signup', async (req, res) => {
  if (authLimiter(clientIp(req))) {
    return res.status(429).json({
      error: 'Too many attempts. Please wait a minute and try again.'
    });
  }

  try {
    const body = req.body || {};
    const username = typeof body.username === 'string'
      ? body.username.trim()
      : '';
    const email = typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';
    const password = body.password;
    const avatar = body.avatar || 'cat';

    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Username, email, and password are required.'
      });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: 'Username must be 3–20 characters using letters, numbers, or underscores.'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.'
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include a letter and a number.'
      });
    }

    if (!db.ALLOWED_AVATARS.has(avatar)) {
      return res.status(400).json({
        error: 'Please choose an available profile avatar.'
      });
    }

    if (db.findUserByEmail(email)) {
      return res.status(409).json({
        error: 'An account with this email already exists.'
      });
    }

    if (db.findUserByUsername(username)) {
      return res.status(409).json({
        error: 'This username is already taken.'
      });
    }

    const passwordHash = await auth.hashPassword(password);

    const user = db.createUser({
      id: crypto.randomUUID(),
      username,
      email,
      passwordHash,
      avatar
    });

    const token = auth.signToken(user.id);
    auth.setSessionCookie(res, token);

    return res.status(201).json({
      user: publicUser(user)
    });
  } catch (error) {
    console.error('[auth/signup] error:', error);

    return res.status(500).json({
      error: 'Could not create your account. Please try again.'
    });
  }
});

/* ===========================================================
   LOG IN
=========================================================== */

app.post('/api/auth/login', async (req, res) => {
  if (authLimiter(clientIp(req))) {
    return res.status(429).json({
      error: 'Too many attempts. Please wait a minute and try again.'
    });
  }

  try {
    const body = req.body || {};
    const identifier = typeof body.identifier === 'string'
      ? body.identifier.trim()
      : typeof body.email === 'string'
        ? body.email.trim()
        : '';
    const password = body.password;

    if (!identifier || typeof password !== 'string') {
      return res.status(400).json({
        error: 'Please enter your email and password.'
      });
    }

    const user = isValidEmail(identifier)
      ? db.findUserByEmail(identifier)
      : db.findUserByUsername(identifier);

    const passwordMatches = user
      ? await auth.verifyPassword(password, user.passwordHash)
      : await auth.verifyPassword(password, auth.DUMMY_HASH);

    if (!user || !passwordMatches) {
      return res.status(401).json({
        error: 'Incorrect email or password.'
      });
    }

    const token = auth.signToken(user.id);
    auth.setSessionCookie(res, token);

    return res.json({
      user: publicUser(user)
    });
  } catch (error) {
    console.error('[auth/login] error:', error);

    return res.status(500).json({
      error: 'Could not sign you in. Please try again.'
    });
  }
});

/* ===========================================================
   LOG OUT
=========================================================== */

app.post(
  '/api/auth/logout',
  requireSameOriginRequest,
  (req, res) => {
    auth.clearSessionCookie(res);
    return res.json({ ok: true });
  }
);

/* ===========================================================
   CURRENT USER
=========================================================== */

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const payload = auth.verifyToken(token);

  if (!payload?.sub) {
    return res.status(401).json({
      error: 'Session expired. Please sign in again.'
    });
  }

  const user = db.findUserById(payload.sub);

  if (!user) {
    return res.status(401).json({
      error: 'Account no longer exists.'
    });
  }

  return res.json({ user: publicUser(user) });
});

/* ===========================================================
   CHANGE PROFILE AVATAR
=========================================================== */

app.put(
  '/api/auth/avatar',
  auth.requireAuth,
  requireSameOriginRequest,
  (req, res) => {
    if (avatarLimiter(clientIp(req))) {
      return res.status(429).json({
        error: 'Too many avatar changes. Please wait a minute.'
      });
    }

    try {
      const avatar = req.body?.avatar;

      if (
        typeof avatar !== 'string' ||
        !db.ALLOWED_AVATARS.has(avatar)
      ) {
        return res.status(400).json({
          error: 'Please choose an available avatar.'
        });
      }

      const user = db.updateUserAvatar(req.userId, avatar);

      return res.json({ user: publicUser(user) });
    } catch (error) {
      console.error('[auth/avatar] error:', error);

      return res.status(500).json({
        error: 'Could not update your avatar. Please try again.'
      });
    }
  }
);

/* ===========================================================
   CLOUD PROGRESS
=========================================================== */

app.get('/api/progress', auth.requireAuth, (req, res) => {
  if (progressLimiter(clientIp(req))) {
    return res.status(429).json({
      error: 'Too many requests. Please slow down.'
    });
  }

  try {
    return res.json({ progress: db.getProgress(req.userId) });
  } catch (error) {
    console.error('[progress/get] error:', error);

    return res.status(500).json({
      error: 'Could not load your progress.'
    });
  }
});

app.put(
  '/api/progress',
  auth.requireAuth,
  requireSameOriginRequest,
  (req, res) => {
    if (progressLimiter(clientIp(req))) {
      return res.status(429).json({
        error: 'Too many requests. Please slow down.'
      });
    }

    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        error: 'Invalid progress data.'
      });
    }

    try {
      return res.json({
        progress: db.saveProgress(req.userId, body)
      });
    } catch (error) {
      console.error('[progress/put] error:', error);

      return res.status(500).json({
        error: 'Could not save your progress.'
      });
    }
  }
);

/* ===========================================================
   DUBIS — GEMINI AI PROXY
=========================================================== */

app.post('/api/dubis', auth.requireAuth, async (req, res) => {
  console.log('[dubis] Request received');

  if (dubisLimiter(clientIp(req))) {
    return res.status(429).json({
      error: 'Too many Dubis requests. Please wait a minute.'
    });
  }

  if (!GEMINI_API_KEY) {
    console.error('[dubis] GEMINI_API_KEY is missing');

    return res.status(503).json({
      error: 'Dubis is temporarily unavailable.'
    });
  }

  const body = req.body || {};
  const system = body.system;
  const messages = body.messages;

  console.log('[dubis] Request shape:', {
    systemType: typeof system,
    systemLength: typeof system === 'string' ? system.length : null,
    messagesType: Array.isArray(messages) ? 'array' : typeof messages,
    messagesCount: Array.isArray(messages) ? messages.length : null
  });

  if (
    typeof system !== 'string' ||
    system.trim().length === 0 ||
    system.length > 50000 ||
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > 20
  ) {
    console.warn('[dubis] Invalid request shape');

    return res.status(400).json({
      error: 'Invalid Dubis request. Expected a system string and a messages array.'
    });
  }

  let totalCharacters = system.length;

  for (const message of messages) {
    if (
      !message ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      message.content.trim().length === 0 ||
      message.content.length > 12000
    ) {
      return res.status(400).json({
        error: 'A message is invalid or too long.'
      });
    }

    totalCharacters += message.content.length;
  }

  if (totalCharacters > 80000) {
    return res.status(400).json({
      error: 'This conversation is too long. Please start a new chat.'
    });
  }

  const contents = messages.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }]
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS
  );

  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      `${GEMINI_MODEL}:generateContent`;

    const upstream = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: system }]
        },
        contents,
        generationConfig: {
          maxOutputTokens: 2048
        }
      })
    });

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => '');

      console.error(
        `[dubis] Gemini returned ${upstream.status}:`,
        errorText.slice(0, 1000)
      );

      return res.status(upstream.status === 429 ? 429 : 502).json({
        error: upstream.status === 429
          ? 'Dubis is busy right now. Please try again shortly.'
          : 'The AI service returned an error. Please try again.'
      });
    }

    const data = await upstream.json();

    const reply = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!reply) {
      console.error('[dubis] Empty or unexpected Gemini response.');

      return res.status(502).json({
        error: 'Dubis could not generate a reply. Please try again.'
      });
    }

    return res.json({ reply });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({
        error: 'Dubis took too long to respond. Please try again.'
      });
    }

    console.error('[dubis] error:', error);

    return res.status(500).json({
      error: 'Unexpected Dubis server error.'
    });
  } finally {
    clearTimeout(timeoutId);
  }
});

/* ===========================================================
   HEALTH CHECK
=========================================================== */

app.get('/api/health', (req, res) => {
  return res.json({
    ok: true,
    hasApiKey: Boolean(GEMINI_API_KEY)
  });
});

/* ===========================================================
   STATIC FRONTEND
=========================================================== */

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  return res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

/* ===========================================================
   START SERVER
=========================================================== */

app.listen(PORT, () => {
  console.log(`Aura Cosmos server listening on port ${PORT}`);
});
