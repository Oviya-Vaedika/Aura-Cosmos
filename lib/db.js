
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.tmp.json');

// Only these avatar IDs are accepted by the backend.
const ALLOWED_AVATARS = new Set([
  'cat', 'bunny', 'fox', 'bear', 'panda',
  'dog', 'penguin', 'frog', 'koala', 'tiger',
  'strawberry', 'peach', 'orange', 'watermelon',
  'avocado', 'pineapple', 'pizza', 'cupcake',
  'donut', 'boba', 'astronaut', 'artist',
  'student', 'gamer'
]);

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
    orbitRushHighScores: {
      desktop: 0,
      mobile: 0
    },
    dailyMystery: null,
    updatedAt: null
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ users: [], progress: {} }, null, 2),
      'utf8'
    );
  }
}

ensureDb();

let cache = null;

function load() {
  if (cache) return cache;

  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.users) ||
      !parsed.progress ||
      typeof parsed.progress !== 'object' ||
      Array.isArray(parsed.progress)
    ) {
      throw new Error('Invalid database structure.');
    }

    cache = parsed;

    // Give older accounts a default avatar without removing their data.
    for (const user of cache.users) {
      if (!ALLOWED_AVATARS.has(user.avatar)) {
        user.avatar = 'cat';
      }
    }

    return cache;
  } catch (error) {
    // Do not silently replace a damaged database with an empty one.
    console.error('[db] Could not load db.json:', error.message);
    throw new Error(
      'The database could not be loaded. Check data/db.json before restarting.'
    );
  }
}

function persist() {
  const db = load();
  const contents = JSON.stringify(db, null, 2);

  try {
    // Write to a temporary file first, then replace the database file.
    fs.writeFileSync(TEMP_FILE, contents, 'utf8');
    fs.renameSync(TEMP_FILE, DB_FILE);
  } catch (error) {
    console.error('[db] Failed to save database:', error.message);

    try {
      if (fs.existsSync(TEMP_FILE)) {
        fs.unlinkSync(TEMP_FILE);
      }
    } catch (cleanupError) {
      console.error('[db] Temporary-file cleanup failed:', cleanupError.message);
    }

    throw new Error('Database save failed. Please try again.');
  }
}

function findUserByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  return load().users.find(
    user => String(user.email || '').toLowerCase() === normalizedEmail
  );
}

function findUserByUsername(username) {
  const normalizedUsername = String(username || '').trim().toLowerCase();

  return load().users.find(
    user => String(user.username || '').toLowerCase() === normalizedUsername
  );
}

function findUserById(id) {
  return load().users.find(user => user.id === id);
}

function createUser({
  id,
  username,
  email,
  passwordHash,
  avatar = 'cat'
}) {
  const db = load();

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedUsername = String(username || '').trim();

  if (!id || !normalizedEmail || !normalizedUsername || !passwordHash) {
    throw new Error('Required user information is missing.');
  }

  if (findUserByEmail(normalizedEmail)) {
    throw new Error('An account with this email already exists.');
  }

  if (findUserByUsername(normalizedUsername)) {
    throw new Error('This username is already taken.');
  }

  if (db.users.some(user => user.id === id)) {
    throw new Error('This user ID already exists.');
  }

  const user = {
    id,
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash,
    avatar: ALLOWED_AVATARS.has(avatar) ? avatar : 'cat',
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  db.progress[id] = defaultProgress();

  persist();
  return user;
}

function updateUserAvatar(userId, avatar) {
  if (!ALLOWED_AVATARS.has(avatar)) {
    throw new Error('Invalid avatar selection.');
  }

  const user = findUserById(userId);

  if (!user) {
    throw new Error('User not found.');
  }

  const previousAvatar = user.avatar;
  user.avatar = avatar;

  try {
    persist();
  } catch (error) {
    user.avatar = previousAvatar;
    throw error;
  }

  return user;
}

function getProgress(userId) {
  const db = load();
  return db.progress[userId] || defaultProgress();
}

function saveProgress(userId, progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new Error('Invalid progress data.');
  }

  const db = load();

  if (!db.users.some(user => user.id === userId)) {
    throw new Error('User not found.');
  }

  const previousProgress = db.progress[userId];

  const clean = {
    xp: safeNumber(progress.xp, 0, 0, 10000000),
    streak: safeNumber(progress.streak, 1, 0, 100000),
    lastVisit:
      typeof progress.lastVisit === 'string'
        ? progress.lastVisit.slice(0, 64)
        : null,

    learnCompleted: safeArray(progress.learnCompleted, 'number').slice(0, 200),
    subProgress: safePlainObject(progress.subProgress),
    exploreDiscoveries: safeArray(progress.exploreDiscoveries, 'string').slice(0, 200),
    gamesCompleted: safeArray(progress.gamesCompleted, 'string').slice(0, 200),
    badges: safeArray(progress.badges, 'string').slice(0, 200),
    visitedSections: safeArray(progress.visitedSections, 'string').slice(0, 50),
    forgedStars: safeArray(progress.forgedStars, 'string').slice(0, 200),
    gameLevels: safePlainObject(progress.gameLevels),
    orbitRushHighScores: safeHighScores(progress.orbitRushHighScores),
    dailyMystery: safeDailyMystery(progress.dailyMystery),
    updatedAt: new Date().toISOString()
  };

  db.progress[userId] = clean;

  try {
    persist();
  } catch (error) {
    if (previousProgress) {
      db.progress[userId] = previousProgress;
    } else {
      delete db.progress[userId];
    }

    throw error;
  }

  return clean;
}

function safeNumber(value, fallback, min, max) {
  const number =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback;

  return Math.max(min, Math.min(max, number));
}

function safeArray(value, itemType) {
  if (!Array.isArray(value)) return [];

  return value.filter(item => typeof item === itemType);
}

function safePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result = {};

  for (const key of Object.keys(value).slice(0, 200)) {
    if (key.length > 100) continue;

    const item = value[key];

    if (Array.isArray(item)) {
      result[key] = item
        .filter(value => typeof value === 'number' || typeof value === 'string')
        .slice(0, 200);
    } else if (
      typeof item === 'string' ||
      (typeof item === 'number' && Number.isFinite(item)) ||
      typeof item === 'boolean'
    ) {
      result[key] = item;
    }
  }

  return result;
}

function safeHighScores(value) {
  return {
    desktop: safeNumber(value?.desktop, 0, 0, 1000000),
    mobile: safeNumber(value?.mobile, 0, 0, 1000000)
  };
}

function safeDailyMystery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  if (
    typeof value.date !== 'string' ||
    typeof value.hypothesis !== 'string' ||
    typeof value.feedback !== 'string'
  ) {
    return null;
  }

  return {
    date: value.date.slice(0, 64),
    hypothesis: value.hypothesis.slice(0, 2000),
    feedback: value.feedback.slice(0, 4000),
    answer: typeof value.answer === 'string'
      ? value.answer.slice(0, 4000)
      : '',
    xp: safeNumber(value.xp, 0, 0, 1000),
    relevance: safeNumber(value.relevance, 0, 0, 10)
  };
}

module.exports = {
  findUserByEmail,
  findUserByUsername,
  findUserById,
  createUser,
  updateUserAvatar,
  getProgress,
  saveProgress,
  defaultProgress,
  ALLOWED_AVATARS
};
