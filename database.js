const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

let data = { warns: [], punishments: [], events: [], reprimands: [] };

function init() {
  if (fs.existsSync(DB_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
  }
  if (!data.warns) data.warns = [];
  if (!data.punishments) data.punishments = [];
  if (!data.events) data.events = [];
  if (!data.reprimands) data.reprimands = [];
  initIdCounter();
  save();
  console.log('✅ База данных инициализирована');
}

function save() {
  // Атомарная запись: сначала во временный файл, потом rename.
  // Иначе падение процесса посреди writeFileSync оставляет битый JSON.
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ID продолжаем от максимального уже существующего, а не от Date.now():
// иначе после рестарта новые записи могут получить id, который уже занят.
let _id = 0;
function initIdCounter() {
  const all = [...data.warns, ...data.punishments, ...data.events, ...data.reprimands];
  const maxId = all.reduce((max, item) => (Number(item?.id) > max ? Number(item.id) : max), 0);
  _id = Math.max(maxId, Date.now());
}
function nextId() { return ++_id; }

// ─── Warns ────────────────────────────────────────────────────────────────────

function addWarn(guildId, userId, modId, modTag, reason) {
  data.warns.push({ id: nextId(), guild_id: guildId, user_id: userId, mod_id: modId, mod_tag: modTag, reason, timestamp: Date.now() });
  save();
  return data.warns.filter(w => w.guild_id === guildId && w.user_id === userId).length;
}

function getWarns(guildId, userId) {
  return data.warns.filter(w => w.guild_id === guildId && w.user_id === userId).sort((a, b) => b.timestamp - a.timestamp);
}

function removeWarn(guildId, userId, num) {
  // Тот же порядок, что и в getWarns (новые сверху) — раньше !снятьварн 1
  // удалял самый старый варн, а не тот, что показан первым в списке.
  const warns = data.warns.filter(w => w.guild_id === guildId && w.user_id === userId).sort((a, b) => b.timestamp - a.timestamp);
  if (!warns.length) return false;
  const target = num ? warns[num - 1] : warns[0];
  if (!target) return false;
  data.warns = data.warns.filter(w => w.id !== target.id);
  save();
  return true;
}

function findPunishment(id) {
  const numericId = Number(id);
  return [...data.warns, ...data.punishments, ...data.reprimands].find(item => item.id === numericId) || null;
}

function updateCaseReason(id, reason) {
  const numericId = Number(id);
  const item = [...data.warns, ...data.punishments, ...data.reprimands].find(entry => entry.id === numericId);
  if (!item) return false;
  item.reason = String(reason || 'Без причины').slice(0, 1000);
  save();
  return true;
}

function removeCase(id) {
  const numericId = Number(id);
  const before = data.warns.length + data.punishments.length + data.reprimands.length;
  data.warns = data.warns.filter(item => item.id !== numericId);
  data.punishments = data.punishments.filter(item => item.id !== numericId);
  data.reprimands = data.reprimands.filter(item => item.id !== numericId);
  const after = data.warns.length + data.punishments.length + data.reprimands.length;
  if (before === after) return false;
  save();
  return true;
}

function getPunishmentsByUser(guildId, userId) {
  return [
    ...data.warns.filter(item => item.guild_id === guildId && item.user_id === userId).map(item => ({ ...item, type: 'warn' })),
    ...data.punishments.filter(item => item.guild_id === guildId && item.user_id === userId).map(item => ({ ...item, type: item.type })),
    ...data.reprimands.filter(item => item.guild_id === guildId && item.user_id === userId).map(item => ({ ...item, type: 'reprimand' })),
  ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function getAllData() {
  return data;
}

// ─── Punishments ──────────────────────────────────────────────────────────────

function addPunishment(guildId, userId, type, expiresAt) {
  data.punishments = data.punishments.filter(p => !(p.guild_id === guildId && p.user_id === userId && p.type === type));
  data.punishments.push({ id: nextId(), guild_id: guildId, user_id: userId, type, expires_at: expiresAt });
  save();
}

function removePunishment(id) {
  data.punishments = data.punishments.filter(p => p.id !== id);
  save();
}

function removePunishmentByUser(guildId, userId, type) {
  data.punishments = data.punishments.filter(p => !(p.guild_id === guildId && p.user_id === userId && p.type === type));
  save();
}

function getExpiredPunishments() {
  return data.punishments.filter(p => p.expires_at && p.expires_at <= Date.now());
}

function getActivePunishments(guildId, type) {
  return data.punishments.filter(p =>
    p.guild_id === guildId &&
    p.type === type &&
    (!p.expires_at || p.expires_at > Date.now())
  );
}

// ─── Events ───────────────────────────────────────────────────────────────────

function addEvent(guildId, name, description, dateTs, organizerIds) {
  const id = nextId();
  const organizers = Array.isArray(organizerIds) ? organizerIds : [organizerIds];
  data.events.push({
    id, guild_id: guildId, name, description,
    date_ts: dateTs,
    organizer_ids: organizers,
    creator_id: organizers[0],
    status: 'active',
    message_id: null, channel_id: null,
    pinged_before: false,
    deleted_after: false,
  });
  save();
  return id;
}

function getUpcomingEvents(guildId) {
  return data.events.filter(e => e.guild_id === guildId && e.date_ts > Date.now() && e.status === 'active').sort((a, b) => a.date_ts - b.date_ts);
}

function getAllActiveEvents() {
  return data.events.filter(e => e.status === 'active');
}

function getEventById(id) {
  return data.events.find(e => e.id === id) || null;
}

function updateEvent(id, fields) {
  const ev = data.events.find(e => e.id === id);
  if (!ev) return false;
  Object.assign(ev, fields);
  save();
  return true;
}

// ─── Reprimands ───────────────────────────────────────────────────────────────

function addReprimand(guildId, userId, modId, modTag, reason, expiresAt = null) {
  data.reprimands.push({ id: nextId(), guild_id: guildId, user_id: userId, mod_id: modId, mod_tag: modTag, reason, expires_at: expiresAt, timestamp: Date.now() });
  save();
  return data.reprimands.filter(r => r.guild_id === guildId && r.user_id === userId).length;
}

function getReprimands(guildId, userId) {
  return data.reprimands.filter(r => r.guild_id === guildId && r.user_id === userId).sort((a, b) => b.timestamp - a.timestamp);
}

function getAllReprimands(guildId) {
  return data.reprimands.filter(r => r.guild_id === guildId).sort((a, b) => b.timestamp - a.timestamp);
}

function removeReprimand(guildId, userId, num) {
  const reps = data.reprimands.filter(r => r.guild_id === guildId && r.user_id === userId).sort((a, b) => a.timestamp - b.timestamp);
  if (!reps.length) return false;
  const target = num ? reps[num - 1] : reps[reps.length - 1];
  if (!target) return false;
  data.reprimands = data.reprimands.filter(r => r.id !== target.id);
  save();
  return true;
}

function getExpiredReprimands() {
  return data.reprimands.filter(r => r.expires_at && r.expires_at <= Date.now());
}

function removeReprimandById(id) {
  data.reprimands = data.reprimands.filter(r => r.id !== id);
  save();
}

module.exports = {
  init,
  addWarn, getWarns, removeWarn,
  findPunishment, updateCaseReason, removeCase, getPunishmentsByUser, getAllData,
  addPunishment, removePunishment, removePunishmentByUser,
  getExpiredPunishments, getActivePunishments,
  addEvent, getUpcomingEvents, getAllActiveEvents, getEventById, updateEvent,
  addReprimand, getReprimands, getAllReprimands, removeReprimand, getExpiredReprimands, removeReprimandById,
};
