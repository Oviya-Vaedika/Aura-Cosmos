// Aura Cosmos backend
// Holds the Anthropic API key server-side and proxies chat requests from Dubis
// (the in-app AI companion) so the key is never exposed to the browser.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const UPSTREAM_TIMEOUT_MS = 20000;

if (!ANTHROPIC_API_KEY) {
  console.warn(
    '\n[WARN] ANTHROPIC_API_KEY is not set.\n' +
    'Dubis chat requests will fail until you add it to a .env file (see .env.example).\n'
  );
}

app.use(express.json({ limit: '256kb' }));

// Very small in-memory rate limiter (per IP) so one user can't accidentally
// hammer the upstream API. Not meant to replace a real production limiter.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

app.post('/api/dubis', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — please slow down a little.' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing its Anthropic API key.' });
  }

  const { system, messages } = req.body || {};

  if (typeof system !== 'string' || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Request must include a system string and a non-empty messages array.' });
  }
  if (messages.length > 20) {
    return res.status(400).json({ error: 'Too many messages in one request.' });
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > 4000) {
      return res.status(400).json({ error: 'Malformed message in request.' });
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        system,
        messages
      })
    });

    clearTimeout(timeoutId);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error(`[dubis] upstream error ${upstream.status}:`, errText);
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({ error: 'The AI service returned an error. Please try again shortly.' });
    }

    const data = await upstream.json();
    const textBlock = Array.isArray(data.content) ? data.content.find(c => c.type === 'text') : null;

    if (!textBlock) {
      return res.status(502).json({ error: 'The AI service returned an unexpected response.' });
    }

    return res.json({ reply: textBlock.text });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('[dubis] upstream request timed out');
      return res.status(504).json({ error: 'The AI service took too long to respond.' });
    }
    console.error('[dubis] unexpected server error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(ANTHROPIC_API_KEY) });
});

// Serve the app itself
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Aura Cosmos server listening on http://localhost:${PORT}`);
});
