// Aura Cosmos backend
// - Proxies Dubis chat requests to Gemini (API key never touches the browser)
// - Handles signup/login/logout with hashed passwords + httpOnly session cookies
// - Stores/serves each signed-in user's cloud progress

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
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Faster timeout: 15 seconds
const UPSTREAM_TIMEOUT_MS = 15000;

// 2 retries = maximum 3 attempts total
const GEMINI_MAX_RETRIES = 2;

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
   RATE LIMITERS
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------
   VALIDATION HELPERS
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
  if (
    typeof v !== 'string' ||
    v.length < 8 ||
    v.length > 200
  ) {
    return false;
  }

  return /[a-zA-Z]/.test(v) &&
    /[0-9]/.test(v);
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
        error: 'Password must be at least 8 characters and include a letter and a number.'
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

    const ok = user
      ? await auth.verifyPassword(password, user.passwordHash)
      : await auth.verifyPassword(password, auth.DUMMY_HASH);

    if (!user || !ok) {
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
    res.json({ ok: true });
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
      const saved = db.saveProgress(req.userId, body);

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
   DUBIS — GEMINI AI PROXY WITH FAST RETRIES
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

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      {
        text: m.content
      }
    ]
  }));

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  let lastErrorStatus = null;
  let lastErrorText = '';

  // Maximum 3 attempts total:
  // Attempt 1 → wait 1 sec if temporary error
  // Attempt 2 → wait 2 sec if temporary error
  // Attempt 3 → final result
  for (
    let attempt = 0;
    attempt <= GEMINI_MAX_RETRIES;
    attempt++
  ) {

    const controller = new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      UPSTREAM_TIMEOUT_MS
    );

    try {
      console.log(
        `[dubis] Gemini attempt ${attempt + 1}/${GEMINI_MAX_RETRIES + 1}`
      );

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

      // SUCCESS
      if (upstream.ok) {
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
      }

      const errText =
        await upstream.text().catch(() => '');

      lastErrorStatus = upstream.status;
      lastErrorText = errText;

      console.error(
        `[dubis] Gemini upstream error ${upstream.status}:`,
        errText
      );

      // Only retry temporary problems
      const shouldRetry =
        upstream.status === 503 ||
        upstream.status === 429 ||
        upstream.status >= 500;

      if (
        shouldRetry &&
        attempt < GEMINI_MAX_RETRIES
      ) {
        const delay =
          1000 * Math.pow(2, attempt);

        console.log(
          `[dubis] Retrying in ${delay}ms...`
        );

        await sleep(delay);
        continue;
      }

      break;

    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        console.error(
          `[dubis] Gemini timed out on attempt ${attempt + 1}`
        );

        lastErrorStatus = 504;
        lastErrorText = 'Request timed out';

      } else {
        console.error(
          `[dubis] Gemini error on attempt ${attempt + 1}:`,
          err
        );

        lastErrorStatus = 500;
        lastErrorText = err.message;
      }

      // Retry timeout/network errors
      if (attempt < GEMINI_MAX_RETRIES) {
        const delay =
          1000 * Math.pow(2, attempt);

        console.log(
          `[dubis] Retrying in ${delay}ms...`
        );

        await sleep(delay);
        continue;
      }
    }
  }

  console.error(
    `[dubis] All Gemini attempts failed. Last status: ${lastErrorStatus}`,
    lastErrorText
  );

  if (lastErrorStatus === 429) {
    return res.status(429).json({
      error: 'Dubis is busy right now. Please try again in a moment.'
    });
  }

  if (lastErrorStatus === 503) {
    return res.status(503).json({
      error: 'Dubis is temporarily experiencing high demand. Please try again shortly.'
    });
  }

  if (lastErrorStatus === 504) {
    return res.status(504).json({
      error: 'Dubis is taking longer than expected. Please try again.'
    });
  }

  return res.status(502).json({
    error: 'The AI service is currently unavailable. Please try again shortly.'
  });
});

/* ===========================================================
   HEALTH CHECK
=========================================================== */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL
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
