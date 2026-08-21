# Aura Cosmos

Astrophysics learning app with Dubis, an AI companion. This version moves all calls
to the Anthropic API behind a small Node/Express backend, so the API key never
touches the browser.

## What changed

Previously, the frontend called `https://api.anthropic.com/v1/messages` directly
from JavaScript. That's insecure for any real deployment — it either requires
embedding an API key in client-side code (visible to anyone via dev tools) or
simply doesn't work outside a sandboxed environment.

Now:
- The frontend calls **`POST /api/dubis`** on your own server.
- `server.js` holds `ANTHROPIC_API_KEY` server-side (via `.env`, never sent to
  the browser) and forwards the request to Anthropic, returning just the reply text.
- The frontend UI, Dubis's personality, chat history, and all app functionality
  (chat panel, Daily Cosmic Mystery, Cosmic Quiz Battle) are unchanged — only the
  transport layer moved.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Add your API key:
   ```
   cp .env.example .env
   ```
   Then edit `.env` and set `ANTHROPIC_API_KEY=sk-ant-...` with a real key from
   [console.anthropic.com](https://console.anthropic.com).

3. Start the server:
   ```
   npm start
   ```

4. Open **http://localhost:3000** — the app is served by the same server that
   handles the `/api/dubis` requests.

## How the backend protects the API key

- `ANTHROPIC_API_KEY` is read only from environment variables (`.env`, which is
  never sent to the browser and should stay out of version control).
- `/api/dubis` validates the request body (system prompt + message array,
  size and role checks) before forwarding anything upstream.
- A basic in-memory per-IP rate limiter (30 requests/minute) guards against
  accidental request storms. For production, swap this for a real rate limiter
  (e.g. `express-rate-limit` backed by Redis) and add authentication if needed.
- Upstream errors, timeouts (20s), and malformed responses are all caught and
  turned into safe, generic error messages — no upstream error details or
  stack traces are leaked to the client.

## Error handling in the app

`callScientist()` in the frontend now:
- Sends requests with a 25-second client-side timeout (`AbortController`).
- Distinguishes timeouts, rate limiting (429), server errors (5xx), and network
  failures, showing a friendly, specific message for each.
- Rolls back the optimistic chat-history entry if a request fails, so a failed
  message doesn't pollute Dubis's conversational memory.

This applies everywhere Dubis is used — the chat panel, the Daily Cosmic Mystery
feedback, and Cosmic Quiz Battle — since they all share the same function.

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Set the
`ANTHROPIC_API_KEY` environment variable in your host's dashboard/secrets
manager rather than committing a `.env` file. The server serves the static
frontend itself, so there's nothing else to configure — point your host at
`npm start`.
