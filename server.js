// Aura Cosmos backend
// - Proxies Dubis chat requests to Gemini (API key never touches the browser)
// - Handles signup/login/logout with hashed passwords + httpOnly session cookies
// - Stores/serves each signed-in user's cloud progress (XP, levels, streaks,
//   lessons, discoveries, games, badges)

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./lib/db');
const auth = require('./lib/auth');

const app = express();

const PORT = process.env.PORT || 3000;

// ===========================================================
// GEMINI CONFIGURATION
// ===========================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const UPSTREAM_TIMEOUT_MS = 40000;

if (!GEMINI_API_KEY) {
  console.warn(
    '\n[WARN] GEMINI_API_KEY is not set.\n' +
    'Dubis chat requests will fail until you add it to Render Environment Variables.\n'
  );
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

/* ---------------------------------------------------------
   Simple in-memory per-IP rate limiters
---------------------------------------------------------- */

function createRateLimiter(maxRequests, windowMs) {
  const buckets = new Map();

  return function isLimited(key) {
    const now = Date.now();

    const recent = (buckets.get(key) || [])
      .filter(t => now - t < windowMs);

    recent.push(now);
    buckets.set(key, recent);

    return recent.length > maxRequests;
  };
}

const dubisLimiter = createRateLimiter(30, 60 * 1000);
const authLimiter = createRateLimiter(8, 60 * 1000);
const progressLimiter = createRateLimiter(60, 60 * 1000);

function clientIp(req) {
  return req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    'unknown';
}

/* ---------------------------------------------------------
   Validation helpers
---------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function isValidEmail(v) {
  return typeof v === 'string' &&
    v.length <= 254 &&
    EMAIL_RE.test(v);
}

function isValidUsername(v) {
  return typeof v === 'string' &&
    USERNAME_RE.test(v);
}

function isValidPassword(v) {
  return typeof v === 'string' &&
    v.length >= 8 &&
    v.length <= 200;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt
  };
}

/* ===========================================================
   AUTH ROUTES
=========================================================== */

app.post('/api/auth/signup', async (req, res) => {

  if (authLimiter(clientIp(req))) {
    return res.status(429).json({
      error: 'Too many attempts. Please wait a minute and try again.'
    });
  }

  try {

    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Username, email, and password are all required.'
      });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: 'Username must be 3-20 characters: letters, numbers, underscores only.'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.'
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters.'
      });
    }

    if (db.findUserByEmail(email)) {
      return res.status(409).json({
        error: 'An account with that email already exists.'
      });
    }

    if (db.findUserByUsername(username)) {
      return res.status(409).json({
        error: 'That username is taken — try another.'
      });
    }

    const passwordHash = await auth.hashPassword(password);

    const id = crypto.randomUUID();

    const user = db.createUser({
      id,
      username,
      email,
      passwordHash
    });

    const token = auth.signToken(user.id);

    auth.setSessionCookie(res, token);

    return res.status(201).json({
      user: publicUser(user)
    });

  } catch (err) {

    console.error('[auth/signup] error:', err);

    return res.status(500).json({
      error: 'Could not create your account right now. Please try again.'
    });
  }
});


app.post('/api/auth/login', async (req, res) => {

  if (authLimiter(clientIp(req))) {
    return res.status(429).json({
      error: 'Too many attempts. Please wait a minute and try again.'
    });
  }

  try {

    const { identifier, password } = req.body || {};

    if (!identifier || !password) {
      return res.status(400).json({
        error: 'Please enter your email/username and password.'
      });
    }

    const user = isValidEmail(identifier)
      ? db.findUserByEmail(identifier)
      : db.findUserByUsername(identifier);

    if (!user) {
      return res.status(401).json({
        error: 'Incorrect email/username or password.'
      });
    }

    const ok = await auth.verifyPassword(
      password,
      user.passwordHash
    );

    if (!ok) {
      return res.status(401).json({
        error: 'Incorrect email/username or password.'
      });
    }

    const token = auth.signToken(user.id);

    auth.setSessionCookie(res, token);

    return res.json({
      user: publicUser(user)
    });

  } catch (err) {

    console.error('[auth/login] error:', err);

    return res.status(500).json({
      error: 'Could not sign you in right now. Please try again.'
    });
  }
});


app.post(
  '/api/auth/logout',
  auth.requireXhrHeader,
  (req, res) => {

    auth.clearSessionCookie(res);

    res.json({
      ok: true
    });
  }
);


app.get('/api/auth/me', (req, res) => {

  const token =
    req.cookies &&
    req.cookies[auth.COOKIE_NAME];

  if (!token) {
    return res.status(401).json({
      error: 'Not signed in.'
    });
  }

  const payload = auth.verifyToken(token);

  if (!payload) {
    return res.status(401).json({
      error: 'Session expired — please sign in again.'
    });
  }

  const user = db.findUserById(payload.sub);

  if (!user) {
    return res.status(401).json({
      error: 'Account no longer exists.'
    });
  }

  res.json({
    user: publicUser(user)
  });
});


/* ===========================================================
   CLOUD PROGRESS ROUTES
=========================================================== */

app.get(
  '/api/progress',
  auth.requireAuth,
  (req, res) => {

    if (progressLimiter(clientIp(req))) {
      return res.status(429).json({
        error: 'Too many requests — please slow down a little.'
      });
    }

    res.json({
      progress: db.getProgress(req.userId)
    });
  }
);


app.put(
  '/api/progress',
  auth.requireAuth,
  auth.requireXhrHeader,
  (req, res) => {

    if (progressLimiter(clientIp(req))) {
      return res.status(429).json({
        error: 'Too many requests — please slow down a little.'
      });
    }

    const body = req.body;

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return res.status(400).json({
        error: 'Invalid progress payload.'
      });
    }

    try {

      const saved = db.saveProgress(
        req.userId,
        body
      );

      res.json({
        progress: saved
      });

    } catch (err) {

      console.error('[progress/put] error:', err);

      res.status(500).json({
        error: 'Could not save your progress right now.'
      });
    }
  }
);


/* ===========================================================
   DUBIS — GEMINI AI PROXY
=========================================================== */

app.post('/api/dubis', async (req, res) => {

  const ip = clientIp(req);

  if (dubisLimiter(ip)) {
    return res.status(429).json({
      error: 'Too many requests — please slow down a little.'
    });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'Server is missing its Gemini API key.'
    });
  }

  const { system, messages } = req.body || {};

  if (
    typeof system !== 'string' ||
    !Array.isArray(messages) ||
    messages.length === 0
  ) {
    return res.status(400).json({
      error: 'Request must include a system string and a non-empty messages array.'
    });
  }

  if (messages.length > 20) {
    return res.status(400).json({
      error: 'Too many messages in one request.'
    });
  }

  for (const m of messages) {

    if (
      !m ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string' ||
      m.content.length > 12000
    ) {
      return res.status(400).json({
        error: 'Malformed message in request.'
      });
    }
  }


  // Convert Anthropic-style messages to Gemini format

  const contents = messages.map(m => ({
    role: m.role === 'assistant'
      ? 'model'
      : 'user',

    parts: [
      {
        text: m.content
      }
    ]
  }));


  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS
  );


  try {

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;


    const upstream = await fetch(url, {

      method: 'POST',

      signal: controller.signal,

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({

        systemInstruction: {
          parts: [
            {
              text: system
            }
          ]
        },

        contents,

        generationConfig: {
          maxOutputTokens: 2048
        }

      })

    });


    clearTimeout(timeoutId);


    if (!upstream.ok) {

      const errText =
        await upstream.text().catch(() => '');

      console.error(
        `[dubis] Gemini upstream error ${upstream.status}:`,
        errText
      );

      const status =
        upstream.status === 429
          ? 429
          : 502;

      return res.status(status).json({
        error: 'The AI service returned an error. Please try again shortly.'
      });
    }


    const data = await upstream.json();


    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();


    if (!reply) {

      console.error(
        '[dubis] Gemini returned an unexpected response:',
        JSON.stringify(data)
      );

      return res.status(502).json({
        error: 'The AI service returned an unexpected response.'
      });
    }


    return res.json({
      reply
    });


  } catch (err) {

    clearTimeout(timeoutId);


    if (err.name === 'AbortError') {

      console.error(
        '[dubis] Gemini request timed out'
      );

      return res.status(504).json({
        error: 'The AI service took too long to respond.'
      });
    }


    console.error(
      '[dubis] unexpected Gemini server error:',
      err
    );

    return res.status(500).json({
      error: 'Unexpected server error.'
    });
  }

});


/* ===========================================================
   HEALTH CHECK
=========================================================== */

app.get('/api/health', (req, res) => {

  res.json({
    ok: true,
    hasApiKey: Boolean(GEMINI_API_KEY)
  });

});


/* ===========================================================
   STATIC FRONTEND
=========================================================== */

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


app.get('*', (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );

});


/* ===========================================================
   START SERVER
=========================================================== */

app.listen(PORT, () => {

  console.log(
    `Aura Cosmos server listening on http://localhost:${PORT}`
  );

});
