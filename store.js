// ─── Хранилище данных (Neon Postgres) ────────────────────────────────────────
// Все модули бота (варны, муты, экономика, тикеты, заявки, настройки, посты)
// хранят своё состояние здесь. Если задан DATABASE_URL — данные лежат в
// Postgres (Neon) и выживают перезапуск Render. Если нет — падаем обратно
// на локальные JSON файлы (удобно для локального запуска).

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const KEYS = ['data', 'economy', 'settings', 'tickets', 'apps', 'new-posts'];
const FLUSH_DELAY_MS = 400;

let pool = null;
let cache = {};
const dirty = new Set();
let flushTimer = null;
let flushing = null;

function fileFor(key) {
  return path.join(DIR, `${key}.json`);
}

function readFile(key) {
  const file = fileFor(key);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`❌ Не удалось прочитать ${key}.json:`, error.message);
    return undefined;
  }
}

function writeFile(key, value) {
  const file = fileFor(key);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function init() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.warn('⚠️ DATABASE_URL не задан — данные пишутся в локальные JSON файлы.');
    console.warn('⚠️ На Render такой диск обнуляется при каждом перезапуске: добавь строку подключения Neon в DATABASE_URL.');
    for (const key of KEYS) {
      const value = readFile(key);
      if (value !== undefined) cache[key] = value;
    }
    return;
  }

  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_store (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT key, value FROM bot_store');
  for (const row of rows) cache[row.key] = row.value;

  // Первый запуск: переносим то, что уже лежит в JSON файлах, в базу.
  for (const key of KEYS) {
    if (cache[key] !== undefined) continue;
    const value = readFile(key);
    if (value === undefined) continue;
    cache[key] = value;
    await upsert(key);
    console.log(`📦 Перенесено в базу: ${key}`);
  }

  console.log(`✅ База данных подключена (Postgres, записей: ${Object.keys(cache).length})`);
}

async function upsert(key) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO bot_store (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(cache[key] ?? null)],
  );
}

function read(key, fallback) {
  const value = cache[key];
  return value === undefined || value === null ? fallback : value;
}

function write(key, value) {
  cache[key] = value;
  if (!pool) {
    try {
      writeFile(key, value);
    } catch (error) {
      console.error(`❌ Не удалось сохранить ${key}.json:`, error.message);
    }
    return;
  }
  dirty.add(key);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(error => console.error('❌ Ошибка записи в базу:', error.message));
  }, FLUSH_DELAY_MS);
}

async function flush() {
  if (!pool) return;
  if (flushing) return flushing;
  const keys = [...dirty];
  dirty.clear();
  if (!keys.length) return;
  flushing = (async () => {
    for (const key of keys) {
      try {
        await upsert(key);
      } catch (error) {
        dirty.add(key);
        console.error(`❌ Не удалось записать "${key}" в базу:`, error.message);
      }
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

async function close() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
  if (pool) await pool.end().catch(() => {});
}

// Render присылает SIGTERM перед остановкой — успеваем дописать изменения.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    close().finally(() => process.exit(0));
  });
}

module.exports = { init, read, write, flush, close, KEYS };
