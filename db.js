// Minimal file-backed data store.
// Good enough for a small app; swap for a real database (Postgres, etc.)
// if this ever needs to handle serious concurrent load.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], progress: {} }, null, 2));
  }
}
ensureDb();

let cache = null;
let writeTimer = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('[db] failed to read db.json, starting fresh:', e.message);
    cache = { users: [], progress: {} };
  }
  return cache;
}

function persist() {
  clearTimeout(writeTimer);
  // Small debounce so rapid writes (e.g. XP ticking up) don't hammer the disk.
  writeTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
      console.error('[db] failed to write db.json:', e.message);
    }
  }, 150);
}

function findUserByEmail(email) {
  return load().users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
}
function findUserByUsername(username) {
  return load().users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
}
function findUserById(id) {
  return load().users.find(u => u.id === id);
}

function createUser({ id, username, email, passwordHash }) {
  const db = load();
  const user = { id, username, email, passwordHash, createdAt: new Date().toISOString() };
  db.users.push(user);
  db.progress[id] = defaultProgress();
  persist();
  return user;
}

function defaultProgress() {
  return {
    xp: 0,
    streak: 1,
    lastVisit: null,
    learnCompleted: [],
    subProgress: {},
    exploreDiscoveries: [],
    gamesCompleted: [],
    badges: [],
    visitedSections: [],
    forgedStars: [],
    gameLevels: {},
    updatedAt: null
  };
}

function getProgress(userId) {
  const db = load();
  return db.progress[userId] || defaultProgress();
}

function saveProgress(userId, progress) {
  const db = load();
  // Only persist known, expected fields — never trust the client blindly.
  const clean = {
    xp: safeNumber(progress.xp, 0, 0, 10_000_000),
    streak: safeNumber(progress.streak, 1, 0, 100000),
    lastVisit: typeof progress.lastVisit === 'string' ? progress.lastVisit.slice(0, 64) : null,
    learnCompleted: safeArray(progress.learnCompleted, 'number').slice(0, 200),
    subProgress: safePlainObject(progress.subProgress),
    exploreDiscoveries: safeArray(progress.exploreDiscoveries, 'string').slice(0, 200),
    gamesCompleted: safeArray(progress.gamesCompleted, 'string').slice(0, 200),
    badges: safeArray(progress.badges, 'string').slice(0, 200),
    visitedSections: safeArray(progress.visitedSections, 'string').slice(0, 50),
    forgedStars: safeArray(progress.forgedStars, 'string').slice(0, 200),
    gameLevels: safePlainObject(progress.gameLevels),
    updatedAt: new Date().toISOString()
  };
  db.progress[userId] = clean;
  persist();
  return clean;
}

function safeNumber(v, fallback, min, max) {
  const n = typeof v === 'number' && isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}
function safeArray(v, itemType) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === itemType);
}
function safePlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const k of Object.keys(v).slice(0, 200)) {
    if (typeof k !== 'string' || k.length > 100) continue;
    const val = v[k];
    if (Array.isArray(val)) out[k] = val.filter(x => typeof x === 'number' || typeof x === 'string').slice(0, 200);
  }
  return out;
}

module.exports = {
  findUserByEmail,
  findUserByUsername,
  findUserById,
  createUser,
  getProgress,
  saveProgress,
  defaultProgress
};
