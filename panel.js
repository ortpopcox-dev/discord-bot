const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const store   = require('./store');

let _client = null;
let _config = null;
let _db     = null;

function init(client, config, db) {
  _client = client;
  _config = config;
  _db     = db;

  const app  = express();
  // Pella provides PORT automatically. The panel is the only HTTP server,
  // so the bot does not try to bind the same port twice.
  const PORT = Number(process.env.PORT || config.PANEL_PORT || 3001);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Сравнение за постоянное время — обычный === утекает длину/префикс пароля.
  function samePassword(candidate) {
    const expected = String(config.PANEL_PASSWORD || '');
    const given = String(candidate || '');
    if (!expected || !given) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // Простой лимит попыток по IP: без него пароль панели брутфорсится за минуты.
  const attempts = new Map();
  const MAX_ATTEMPTS = 8;
  const ATTEMPT_WINDOW = 10 * 60 * 1000;

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  }

  function tooManyAttempts(req) {
    const entry = attempts.get(clientIp(req));
    if (!entry) return false;
    if (Date.now() - entry.first > ATTEMPT_WINDOW) { attempts.delete(clientIp(req)); return false; }
    return entry.count >= MAX_ATTEMPTS;
  }

  function noteFailure(req) {
    const ip = clientIp(req);
    const entry = attempts.get(ip);
    if (!entry || Date.now() - entry.first > ATTEMPT_WINDOW) attempts.set(ip, { count: 1, first: Date.now() });
    else entry.count += 1;
  }

  function auth(req, res, next) {
    // Токен принимаем только в заголовке: в ?token= он утекал в логи и Referer.
    if (samePassword(req.headers['x-panel-token'])) return next();
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  app.get('/', (req, res) => res.send(getHTML()));

  app.post('/api/login', (req, res) => {
    if (tooManyAttempts(req)) {
      return res.status(429).json({ error: 'Слишком много попыток. Попробуй через 10 минут.' });
    }
    if (samePassword(req.body?.password)) {
      attempts.delete(clientIp(req));
      return res.json({ success: true });
    }
    noteFailure(req);
    return res.status(401).json({ error: 'Неверный пароль' });
  });

  app.get('/api/members', auth, async (req, res) => {
    try {
      const guild = _client.guilds.cache.first();
      if (!guild) return res.json([]);
      await guild.members.fetch();
      const q = (req.query.q || '').toLowerCase();
      const members = guild.members.cache
        .filter(m => !m.user.bot && (!q || m.user.username.toLowerCase().includes(q) || (m.user.globalName || '').toLowerCase().includes(q)))
        .map(m => ({ id: m.id, tag: m.user.tag, username: m.user.globalName || m.user.username }))
        .slice(0, 25);
      res.json(members);
    } catch(e) { res.json([]); }
  });

  app.get('/api/channels', auth, async (req, res) => {
    try {
      const guild = _client.guilds.cache.first();
      if (!guild) return res.json([]);
      const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
      res.json(channels);
    } catch(e) { res.json([]); }
  });

  app.post('/api/mute', auth, async (req, res) => {
    try {
      const { userId, reason, duration } = req.body;
      const guild  = _client.guilds.cache.first();
      const member = await guild.members.fetch(userId);
      await member.roles.add(_config.MUTE_ROLE_ID);
      if (duration && parseInt(duration) > 0) {
        _db.addPunishment(guild.id, userId, 'mute', Date.now() + parseInt(duration));
      }
      await sendDM(member.user, 'mute', reason, duration ? parseInt(duration) : null);
      res.json({ success: true, message: member.user.tag + ' замучен' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/unmute', auth, async (req, res) => {
    try {
      const { userId } = req.body;
      const guild  = _client.guilds.cache.first();
      const member = await guild.members.fetch(userId);
      await member.roles.remove(_config.MUTE_ROLE_ID);
      _db.removePunishmentByUser(guild.id, userId, 'mute');
      res.json({ success: true, message: member.user.tag + ' размучен' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/warn', auth, async (req, res) => {
    try {
      const { userId, reason } = req.body;
      const guild  = _client.guilds.cache.first();
      const member = await guild.members.fetch(userId);
      const count  = _db.addWarn(guild.id, userId, 'panel', 'Панель управления', reason || 'Без причины');
      await sendDM(member.user, 'warn', reason, null, count);
      res.json({ success: true, message: member.user.tag + ' получил варн (всего: ' + count + ')' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/warns/:userId', auth, (req, res) => {
    try {
      const guild = _client.guilds.cache.first();
      res.json(_db.getWarns(guild.id, req.params.userId));
    } catch(e) { res.json([]); }
  });

  app.delete('/api/warns/:userId/:num', auth, (req, res) => {
    try {
      const guild   = _client.guilds.cache.first();
      const removed = _db.removeWarn(guild.id, req.params.userId, parseInt(req.params.num));
      res.json({ success: removed });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/kick', auth, async (req, res) => {
    try {
      const { userId, reason } = req.body;
      const guild  = _client.guilds.cache.first();
      const member = await guild.members.fetch(userId);
      const tag    = member.user.tag;
      await sendDM(member.user, 'kick', reason);
      await member.kick(reason || 'Панель управления');
      res.json({ success: true, message: tag + ' кикнут' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ban', auth, async (req, res) => {
    try {
      const { userId, reason } = req.body;
      const guild  = _client.guilds.cache.first();
      const member = await guild.members.fetch(userId).catch(() => null);
      const tag    = member ? member.user.tag : userId;
      if (member) await sendDM(member.user, 'ban', reason);
      await guild.members.ban(userId, { reason: reason || 'Панель управления' });
      res.json({ success: true, message: tag + ' забанен' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/events', auth, (req, res) => {
    try {
      const guild = _client.guilds.cache.first();
      res.json(_db.getUpcomingEvents(guild.id));
    } catch(e) { res.json([]); }
  });

  app.post('/api/events', auth, async (req, res) => {
    try {
      const { name, description, timestamp, channelId, organizerId } = req.body;
      const guild   = _client.guilds.cache.first();
      const dateTs  = parseInt(timestamp);
      if (!dateTs || isNaN(dateTs)) return res.status(400).json({ error: 'Неверный формат даты' });
      let organizerMention = 'Панель управления';
      if (organizerId) {
        const org = await guild.members.fetch(organizerId).catch(() => null);
        if (org) organizerMention = '<@' + organizerId + '>';
      }
      const evId = _db.addEvent(guild.id, name, description, dateTs, organizerId ? [organizerId] : ['panel']);
      if (channelId) {
        const channel = guild.channels.cache.get(channelId);
        const ts      = Math.floor(dateTs / 1000);
        if (channel) {
          const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
          const e = new EmbedBuilder()
            .setColor(0x5865f2).setTitle('📅 Новый ивент: ' + name).setDescription(description)
            .addFields({ name: '⏰ Дата', value: '<t:' + ts + ':F> (<t:' + ts + ':R>)', inline: false }, { name: '👤 Организатор', value: organizerMention, inline: true })
            .setTimestamp();
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('event_postpone_' + evId).setLabel('📅 Перенести').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('event_cancel_' + evId).setLabel('❌ Отменить').setStyle(ButtonStyle.Danger),
          );
          const msg = await channel.send({ embeds: [e], components: [row] });
          _db.updateEvent(evId, { message_id: msg.id, channel_id: channelId });
        }
      }
      res.json({ success: true, message: 'Ивент "' + name + '" создан' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/events/:id/postpone', auth, async (req, res) => {
    try {
      const { timestamp, reason, channelId } = req.body;
      const guild  = _client.guilds.cache.first();
      const dateTs = parseInt(timestamp);
      if (!dateTs || isNaN(dateTs)) return res.status(400).json({ error: 'Неверный формат даты' });
      const ts = Math.floor(dateTs / 1000);
      _db.updateEvent(parseInt(req.params.id), { date_ts: dateTs, pinged_before: false, deleted_after: false });
      if (channelId) {
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
          const { EmbedBuilder } = require('discord.js');
          await channel.send({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('📅 Ивент перенесён')
            .setDescription('**Причина:** ' + (reason || 'Без причины') + '\n\n**Новое время:** <t:' + ts + ':F> (<t:' + ts + ':R>)').setTimestamp()] });
        }
      }
      res.json({ success: true, message: 'Ивент перенесён' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/events/:id/cancel', auth, async (req, res) => {
    try {
      const { reason, channelId } = req.body;
      const guild = _client.guilds.cache.first();
      const ev    = _db.getEventById(parseInt(req.params.id));
      _db.updateEvent(parseInt(req.params.id), { status: 'cancelled' });
      if (ev && ev.message_id && ev.channel_id) {
        const ch = guild.channels.cache.get(ev.channel_id);
        if (ch) { const msg = await ch.messages.fetch(ev.message_id).catch(() => null); if (msg) await msg.delete().catch(() => {}); }
      }
      if (channelId) {
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
          const { EmbedBuilder } = require('discord.js');
          await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ Ивент отменён')
            .setDescription('**Причина:** ' + (reason || 'Без причины')).setTimestamp()] });
        }
      }
      res.json({ success: true, message: 'Ивент отменён' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Тикеты ──────────────────────────────────────────────────────────────────
  app.get('/api/tickets', auth, (req, res) => {
    try {
      const tickets = store.read('tickets', {}) || {};
      res.json(Object.values(tickets));
    } catch(e) { res.json([]); }
  });

  // Ответить в тикет (написать в канал тикета)
  app.post('/api/tickets/:id/reply', auth, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Пустое сообщение' });
      const tickets = store.read('tickets', {}) || {};
      const ticket  = tickets[req.params.id];
      if (!ticket) return res.status(404).json({ error: 'Тикет не найден' });
      if (ticket.status === 'closed') return res.status(400).json({ error: 'Тикет закрыт' });
      const guild   = _client.guilds.cache.first();
      const channel = guild.channels.cache.get(ticket.channelId);
      if (!channel) return res.status(404).json({ error: 'Канал тикета не найден или удалён' });
      const { EmbedBuilder } = require('discord.js');
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(0x5865f2).setTitle('💬 Ответ от администрации').setDescription(message)
        .setFooter({ text: 'Панель управления' }).setTimestamp()
      ]});
      res.json({ success: true, message: 'Сообщение отправлено в тикет' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Заявки ──────────────────────────────────────────────────────────────────
  app.get('/api/apps', auth, (req, res) => {
    try {
      const apps = store.read('apps', {}) || {};
      res.json(Object.values(apps));
    } catch(e) { res.json([]); }
  });

  // Написать заявителю в ЛС
  app.post('/api/apps/:id/reply', auth, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Пустое сообщение' });
      const apps = store.read('apps', {}) || {};
      const app  = apps[req.params.id];
      if (!app) return res.status(404).json({ error: 'Заявка не найдена' });
      const user = await _client.users.fetch(app.userId).catch(() => null);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
      const { EmbedBuilder } = require('discord.js');
      await user.send({ embeds: [new EmbedBuilder()
        .setColor(0x5865f2).setTitle('💬 Сообщение по заявке #' + app.id)
        .setDescription(message).setFooter({ text: 'Администрация сервера' }).setTimestamp()
      ]});
      res.json({ success: true, message: 'Сообщение отправлено в ЛС заявителю' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Панель умеет банить и кикать — без пароля её нельзя поднимать вообще.
  if (!config.PANEL_PASSWORD || String(config.PANEL_PASSWORD).length < 8) {
    console.error('❌ Веб-панель НЕ запущена: задай PANEL_PASSWORD длиной от 8 символов.');
    return;
  }

  app.listen(PORT, () => console.log('✅ Веб-панель запущена на порту ' + PORT));
}

// ── DM helper ────────────────────────────────────────────────────────────────
async function sendDM(user, type, reason, durationMs, warnCount) {
  try {
    const { EmbedBuilder } = require('discord.js');
    const guild = _client.guilds.cache.first();
    const guildName = guild ? guild.name : 'сервере';
    const configs = {
      warn: { color: 0xfee75c, title: '⚠️ Вы получили предупреждение', desc: 'Вы получили предупреждение на сервере **' + guildName + '**.', extra: warnCount ? { name: '📊 Всего варнов', value: String(warnCount), inline: true } : null },
      mute: { color: 0xfee75c, title: '🔇 Вы были замучены', desc: 'Вам выдан мут на сервере **' + guildName + '**.', extra: durationMs ? { name: '⏱️ Длительность', value: formatDuration(durationMs), inline: true } : { name: '⏱️ Длительность', value: 'Постоянный', inline: true } },
      kick: { color: 0xed4245, title: '🦵 Вы были кикнуты', desc: 'Вы были кикнуты с сервера **' + guildName + '**.', extra: null },
      ban:  { color: 0xed4245, title: '🔨 Вы были заблокированы', desc: 'Вы получили бан на сервере **' + guildName + '**.', extra: null },
    };
    const cfg = configs[type];
    if (!cfg) return;
    const embed = new EmbedBuilder().setColor(cfg.color).setTitle(cfg.title).setDescription(cfg.desc)
      .addFields({ name: '📋 Причина', value: reason || 'Без причины', inline: true })
      .setTimestamp().setFooter({ text: 'Если вы считаете это ошибкой, обратитесь к администрации' });
    if (cfg.extra) embed.addFields(cfg.extra);
    await user.send({ embeds: [embed] });
  } catch(e) {}
}

function formatDuration(ms) {
  const d = Math.floor(ms/86400000), h = Math.floor((ms%86400000)/3600000), m = Math.floor((ms%3600000)/60000);
  const parts = [];
  if (d) parts.push(d+'д'); if (h) parts.push(h+'ч'); if (m) parts.push(m+'м');
  return parts.join(' ') || '<1м';
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Onest:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0d0e11;--sb:#111318;--card:#161820;--card2:#1c1e26;--input:#0d0e11;
  --border:#252830;--border2:#2e3140;--text:#e8eaf0;--muted:#6b7280;--muted2:#9098a8;
  --accent:#6c71f0;--accent2:#8287f5;--green:#3dd68c;--red:#f05252;--yellow:#f0b429;--blue:#52a9f0;
  --r:10px;--font:"Onest",sans-serif;--mono:"JetBrains Mono",monospace;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);display:flex;height:100vh;overflow:hidden;font-size:14px}
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100}
.lbox{background:var(--card);padding:44px 40px;border-radius:16px;width:380px;text-align:center;border:1px solid var(--border2);box-shadow:0 24px 64px rgba(0,0,0,.5)}
.lbox .logo{width:56px;height:56px;background:linear-gradient(135deg,var(--accent),#a78bfa);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 18px}
.lbox h1{font-size:20px;font-weight:700;margin-bottom:4px}
.lbox p{color:var(--muted2);font-size:13px;margin-bottom:28px}
.lbox input{width:100%;padding:11px 14px;background:var(--input);border:1.5px solid var(--border2);border-radius:var(--r);color:var(--text);font-size:14px;margin-bottom:10px;outline:none;font-family:var(--font);transition:.2s}
.lbox input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(108,113,240,.15)}
.lbox button{width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:var(--r);font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);transition:.15s}
.lbox button:hover{background:var(--accent2)}
.lerr{color:var(--red);font-size:12px;margin-top:8px;display:none;font-weight:500}
#sb{width:220px;background:var(--sb);display:flex;flex-direction:column;padding:12px 8px;gap:2px;flex-shrink:0;border-right:1px solid var(--border)}
.sb-logo{padding:10px 10px 18px;display:flex;align-items:center;gap:10px}
.sb-logo .ico{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),#a78bfa);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.sb-logo span{font-size:14px;font-weight:700}
.sb-sect{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;padding:10px 10px 4px}
.ni{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;cursor:pointer;color:var(--muted2);font-size:13px;font-weight:500;transition:.15s;position:relative}
.ni:hover{background:var(--card);color:var(--text)}
.ni.active{background:rgba(108,113,240,.15);color:var(--accent2)}
.ni.active::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:60%;background:var(--accent);border-radius:0 3px 3px 0}
.ni .ic{font-size:15px;width:20px;text-align:center}
#main{flex:1;overflow-y:auto;padding:24px 28px;background:var(--bg)}
.page{display:none}.page.active{display:block}
.ptitle{font-size:18px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.back-btn{background:var(--card2);border:1px solid var(--border2);color:var(--muted2);padding:5px 12px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font);transition:.15s}
.back-btn:hover{border-color:var(--accent);color:var(--accent)}
.card{background:var(--card);border-radius:var(--r);padding:20px;margin-bottom:14px;border:1px solid var(--border)}
.ctitle{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;display:flex;align-items:center;gap:6px}
.ctitle::before{content:"";width:3px;height:11px;background:var(--accent);border-radius:2px}
.frow{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:5px;flex:1;min-width:150px}
.fg label{font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.06em}
.fg input,.fg select,.fg textarea{padding:9px 12px;background:var(--input);border:1.5px solid var(--border2);border-radius:var(--r);color:var(--text);font-size:13px;outline:none;font-family:var(--font);transition:.2s}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(108,113,240,.12)}
.fg select{cursor:pointer}.fg select option{background:var(--card)}
.fg textarea{resize:vertical;min-height:70px}
.search-wrap{position:relative}.search-wrap input{width:100%}
.sdrop{position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--card2);border:1.5px solid var(--border2);border-radius:var(--r);z-index:50;max-height:200px;overflow-y:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.sitem{padding:9px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px;transition:.1s}
.sitem:hover{background:rgba(108,113,240,.15)}
.sitem .sid{font-family:var(--mono);font-size:11px;color:var(--muted);margin-left:auto}
.sel-user{background:rgba(108,113,240,.1);border:1.5px solid rgba(108,113,240,.3);border-radius:8px;padding:8px 12px;font-size:13px;display:none;align-items:center;gap:8px;margin-top:6px}
.sel-user .stag{flex:1;font-weight:500}
.sel-user .sid2{font-family:var(--mono);font-size:11px;color:var(--muted)}
.sel-user .sclr{background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;padding:0 2px;transition:.15s}
.sel-user .sclr:hover{color:var(--red)}
.btn{padding:9px 18px;border:none;border-radius:var(--r);font-size:13px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap;font-family:var(--font)}
.btn:hover{filter:brightness(1.1);transform:translateY(-1px)}.btn:active{transform:scale(.97)}
.bp{background:var(--accent);color:#fff}
.bs{background:rgba(61,214,140,.15);color:var(--green);border:1.5px solid rgba(61,214,140,.25)}.bs:hover{background:rgba(61,214,140,.25)}
.bd{background:rgba(240,82,82,.15);color:var(--red);border:1.5px solid rgba(240,82,82,.25)}.bd:hover{background:rgba(240,82,82,.25)}
.bw{background:rgba(240,180,41,.15);color:var(--yellow);border:1.5px solid rgba(240,180,41,.25)}.bw:hover{background:rgba(240,180,41,.25)}
.bg{background:var(--card2);color:var(--muted2);border:1.5px solid var(--border2)}.bg:hover{color:var(--text)}
.btn-sm{padding:5px 11px;font-size:12px}
.dur-btns{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;align-items:center}
.dur-btns span{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.dur-btns .btn{padding:4px 10px;font-size:11px;font-family:var(--mono)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;color:var(--muted);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.bg2{background:rgba(61,214,140,.12);color:var(--green)}.br2{background:rgba(240,82,82,.12);color:var(--red)}
.by2{background:rgba(240,180,41,.12);color:var(--yellow)}.bb2{background:rgba(82,169,240,.12);color:var(--blue)}
.ba2{background:rgba(108,113,240,.12);color:var(--accent2)}
.ev-card{background:var(--card2);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;gap:14px;transition:.15s}
.ev-card:hover{border-color:var(--border2)}
.ev-dot{width:8px;height:8px;background:var(--accent);border-radius:50%;flex-shrink:0;box-shadow:0 0 8px var(--accent)}
.ev-info{flex:1;min-width:0}.ev-info h4{font-size:13px;font-weight:600;margin-bottom:3px}.ev-info p{font-size:12px;color:var(--muted2)}
.ev-actions{display:flex;gap:6px;flex-shrink:0}
.detail-card{background:var(--card2);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px}
.detail-card .drow{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.detail-card .dlabel{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:3px}
.detail-card .dval{font-size:13px;font-weight:500}
.reply-box{margin-top:12px;display:flex;gap:8px}
.reply-box textarea{flex:1;padding:9px 12px;background:var(--input);border:1.5px solid var(--border2);border-radius:var(--r);color:var(--text);font-size:13px;outline:none;font-family:var(--font);resize:none;height:70px;transition:.2s}
.reply-box textarea:focus{border-color:var(--accent)}
.reply-box button{align-self:flex-end}
#toast{position:fixed;bottom:22px;right:22px;display:flex;flex-direction:column;gap:7px;z-index:999}
.toast{padding:11px 16px;border-radius:var(--r);font-size:13px;font-weight:500;animation:tin .25s ease;max-width:320px;border:1px solid transparent}
.ts{background:#0d2318;color:var(--green);border-color:rgba(61,214,140,.2)}.te{background:#200d0d;color:var(--red);border-color:rgba(240,82,82,.2)}
@keyframes tin{from{transform:translateX(80px);opacity:0}to{transform:translateX(0);opacity:1}}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
.action-row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.mono{font-family:var(--mono);font-size:12px}
.answers-block{margin-top:10px}
.answer-item{padding:8px 12px;background:var(--card);border-radius:8px;margin-bottom:6px;border-left:3px solid var(--accent)}
.answer-item .aq{font-size:11px;color:var(--muted2);margin-bottom:3px}
.answer-item .aa{font-size:13px}
</style>
</head>
<body>
<div id="login">
  <div class="lbox">
    <div class="logo">🛡️</div>
    <h1>Bot Panel</h1>
    <p>Введите пароль для доступа</p>
    <input type="password" id="pwd" placeholder="Пароль" onkeydown="if(event.key==='Enter')doLogin()">
    <button onclick="doLogin()">Войти</button>
    <div class="lerr" id="lerr">❌ Неверный пароль</div>
  </div>
</div>

<div id="sb" style="display:none">
  <div class="sb-logo"><div class="ico">🤖</div><span>Bot Panel</span></div>
  <div class="sb-sect">Модерация</div>
  <div class="ni active" onclick="sp('mute')" data-p="mute"><span class="ic">🔇</span> Мут / Размут</div>
  <div class="ni" onclick="sp('warn')" data-p="warn"><span class="ic">⚠️</span> Варны</div>
  <div class="ni" onclick="sp('bankick')" data-p="bankick"><span class="ic">🔨</span> Бан / Кик</div>
  <div class="sb-sect">Сервер</div>
  <div class="ni" onclick="sp('events')" data-p="events"><span class="ic">📅</span> Ивенты</div>
  <div class="ni" onclick="sp('tickets')" data-p="tickets"><span class="ic">🎫</span> Тикеты</div>
  <div class="ni" onclick="sp('apps')" data-p="apps"><span class="ic">📋</span> Заявки</div>
</div>

<div id="main" style="display:none">

<!-- МУТ -->
<div class="page active" id="page-mute">
  <div class="ptitle">🔇 Мут / Размут</div>
  <div class="card">
    <div class="ctitle">Поиск участника</div>
    <div class="fg">
      <label>Имя или ID</label>
      <div class="search-wrap">
        <input type="text" id="mute-search" placeholder="Введите имя..." autocomplete="off" oninput="doSearch('mute',this.value)">
        <div class="sdrop" id="mute-drop"></div>
      </div>
      <input type="hidden" id="mute-uid">
      <div class="sel-user" id="mute-sel">
        <span>👤</span><span class="stag" id="mute-sel-tag"></span>
        <span class="sid2" id="mute-sel-id"></span>
        <button class="sclr" onclick="clearSel('mute')">×</button>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Выдать мут</div>
    <div class="frow">
      <div class="fg"><label>Причина</label><input type="text" id="mute-reason" placeholder="Причина мута..."></div>
      <div class="fg" style="max-width:150px"><label>Длительность (мин)</label><input type="number" id="mute-dur" placeholder="0 = ∞" min="0"></div>
    </div>
    <div class="dur-btns">
      <span>Быстро:</span>
      <button class="btn bg" onclick="setDur(5)">5м</button>
      <button class="btn bg" onclick="setDur(10)">10м</button>
      <button class="btn bg" onclick="setDur(30)">30м</button>
      <button class="btn bg" onclick="setDur(60)">1ч</button>
      <button class="btn bg" onclick="setDur(360)">6ч</button>
      <button class="btn bg" onclick="setDur(1440)">1д</button>
      <button class="btn bg" onclick="setDur(10080)">1нед</button>
      <button class="btn bd btn-sm" onclick="setDur(0)">∞</button>
    </div>
    <div class="action-row">
      <button class="btn bw" onclick="doMute()">🔇 Замутить</button>
      <button class="btn bs" onclick="doUnmute()">🔊 Размутить</button>
    </div>
  </div>
</div>

<!-- ВАРНЫ -->
<div class="page" id="page-warn">
  <div class="ptitle">⚠️ Варны</div>
  <div class="card">
    <div class="ctitle">Поиск участника</div>
    <div class="fg">
      <label>Имя или ID</label>
      <div class="search-wrap">
        <input type="text" id="warn-search" placeholder="Введите имя..." autocomplete="off" oninput="doSearch('warn',this.value)">
        <div class="sdrop" id="warn-drop"></div>
      </div>
      <input type="hidden" id="warn-uid">
      <div class="sel-user" id="warn-sel">
        <span>👤</span><span class="stag" id="warn-sel-tag"></span>
        <span class="sid2" id="warn-sel-id"></span>
        <button class="sclr" onclick="clearSel('warn')">×</button>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Выдать варн</div>
    <div class="frow">
      <div class="fg"><label>Причина</label><input type="text" id="warn-reason" placeholder="Причина..."></div>
      <button class="btn bw" style="align-self:flex-end" onclick="doWarn()">⚠️ Выдать варн</button>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">История варнов</div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>#</th><th>Причина</th><th>Модератор</th><th>Дата</th><th></th></tr></thead>
      <tbody id="warns-list"><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">Выберите участника</td></tr></tbody>
    </table></div>
  </div>
</div>

<!-- БАН/КИК -->
<div class="page" id="page-bankick">
  <div class="ptitle">🔨 Бан / Кик</div>
  <div class="card">
    <div class="ctitle">Поиск участника</div>
    <div class="fg">
      <label>Имя или ID</label>
      <div class="search-wrap">
        <input type="text" id="bk-search" placeholder="Введите имя..." autocomplete="off" oninput="doSearch('bk',this.value)">
        <div class="sdrop" id="bk-drop"></div>
      </div>
      <input type="hidden" id="bk-uid">
      <div class="sel-user" id="bk-sel">
        <span>👤</span><span class="stag" id="bk-sel-tag"></span>
        <span class="sid2" id="bk-sel-id"></span>
        <button class="sclr" onclick="clearSel('bk')">×</button>
      </div>
    </div>
  </div>
  <div style="display:flex;gap:14px;flex-wrap:wrap">
    <div class="card" style="flex:1;min-width:260px;margin-bottom:0">
      <div class="ctitle">Кик</div>
      <div class="fg"><label>Причина</label><input type="text" id="kick-reason" placeholder="Причина..."></div>
      <div class="action-row"><button class="btn bw" onclick="doKick()">🦵 Кикнуть</button></div>
    </div>
    <div class="card" style="flex:1;min-width:260px;margin-bottom:0">
      <div class="ctitle">Бан</div>
      <div class="fg"><label>Причина</label><input type="text" id="ban-reason" placeholder="Причина..."></div>
      <div class="action-row"><button class="btn bd" onclick="doBan()">🔨 Забанить</button></div>
    </div>
  </div>
</div>

<!-- ИВЕНТЫ -->
<div class="page" id="page-events">
  <div class="ptitle">📅 Ивенты</div>
  <div class="card">
    <div class="ctitle">Создать ивент</div>
    <div class="frow">
      <div class="fg"><label>Название</label><input type="text" id="ev-name" placeholder="Название ивента"></div>
      <div class="fg"><label>Дата и время</label><input type="datetime-local" id="ev-date"></div>
    </div>
    <div class="frow" style="margin-top:10px">
      <div class="fg"><label>Описание</label><textarea id="ev-desc" placeholder="Описание..."></textarea></div>
      <div class="fg">
        <label>Канал</label>
        <select id="ev-channel"><option value="">Не отправлять</option></select>
        <label style="margin-top:10px">ID Организатора</label>
        <input type="text" id="org-uid" placeholder="Discord ID">
      </div>
    </div>
    <div class="action-row"><button class="btn bp" onclick="doCreateEvent()">📅 Создать</button></div>
  </div>
  <div class="card">
    <div class="ctitle">Предстоящие ивенты</div>
    <div id="events-list"><div style="color:var(--muted);text-align:center;padding:24px">Загрузка...</div></div>
  </div>
</div>

<!-- ИВЕНТ ACTION -->
<div class="page" id="page-ev-action">
  <div class="ptitle">
    <button class="back-btn" onclick="sp('events')">← Назад</button>
    <span id="ev-action-title"></span>
  </div>
  <div class="card" id="ev-postpone-form">
    <div class="ctitle">Перенести</div>
    <div class="frow">
      <div class="fg"><label>Новая дата</label><input type="datetime-local" id="ev-new-date"></div>
      <div class="fg"><label>Причина</label><input type="text" id="ev-postpone-reason" placeholder="Причина..."></div>
      <div class="fg"><label>Канал</label><select id="ev-postpone-channel"><option value="">Не отправлять</option></select></div>
    </div>
    <div class="action-row"><button class="btn bp" onclick="doPostpone()">📅 Перенести</button></div>
  </div>
  <div class="card" id="ev-cancel-form" style="display:none">
    <div class="ctitle">Отмена</div>
    <div class="frow">
      <div class="fg"><label>Причина</label><input type="text" id="ev-cancel-reason" placeholder="Причина..."></div>
      <div class="fg"><label>Канал</label><select id="ev-cancel-channel"><option value="">не отправлять</option></select></div>
    </div>
    <div class="action-row"><button class="btn bd" onclick="doCancel()">❌ Отменить</button></div>
  </div>
</div>

<!-- ТИКЕТЫ -->
<div class="page" id="page-tickets">
  <div class="ptitle">🎫 Тикеты</div>
  <div class="card">
    <div style="overflow-x:auto"><table>
      <thead><tr><th>ID</th><th>Пользователь</th><th>Категория</th><th>Статус</th><th>Дата</th><th></th></tr></thead>
      <tbody id="tickets-list"><tr><td colspan="6" style="color:var(--muted);text-align:center;padding:20px">Загрузка...</td></tr></tbody>
    </table></div>
  </div>
</div>

<!-- ТИКЕТ ДЕТАЛИ -->
<div class="page" id="page-ticket-detail">
  <div class="ptitle">
    <button class="back-btn" onclick="sp('tickets')">← Назад</button>
    <span id="ticket-detail-title">Тикет</span>
  </div>
  <div class="detail-card" id="ticket-info"></div>
  <div class="card">
    <div class="ctitle">Ответить в тикет</div>
    <div class="reply-box">
      <textarea id="ticket-reply-msg" placeholder="Напишите сообщение — оно появится в канале тикета..."></textarea>
      <button class="btn bp" onclick="replyTicket()">📨 Отправить</button>
    </div>
  </div>
</div>

<!-- ЗАЯВКИ -->
<div class="page" id="page-apps">
  <div class="ptitle">📋 Заявки</div>
  <div class="card">
    <div style="overflow-x:auto"><table>
      <thead><tr><th>ID</th><th>Пользователь</th><th>Позиция</th><th>Статус</th><th>Дата</th><th></th></tr></thead>
      <tbody id="apps-list"><tr><td colspan="6" style="color:var(--muted);text-align:center;padding:20px">Загрузка...</td></tr></tbody>
    </table></div>
  </div>
</div>

<!-- ЗАЯВКА ДЕТАЛИ -->
<div class="page" id="page-app-detail">
  <div class="ptitle">
    <button class="back-btn" onclick="sp('apps')">← Назад</button>
    <span id="app-detail-title">Заявка</span>
  </div>
  <div class="detail-card" id="app-info"></div>
  <div class="card">
    <div class="ctitle">Написать заявителю в ЛС</div>
    <div class="reply-box">
      <textarea id="app-reply-msg" placeholder="Напишите сообщение — оно придёт в ЛС заявителю..."></textarea>
      <button class="btn bp" onclick="replyApp()">📨 Отправить</button>
    </div>
  </div>
</div>

</div>
<div id="toast"></div>

<script>
var TOKEN = "";
var channels = [];
var currentEvId = null;
var searchTimers = {};
var currentTicketId = null;
var currentAppId = null;

function doLogin() {
  var pwd = document.getElementById("pwd").value;
  fetch("/api/login", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pwd})})
  .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
  .then(function(x){
    if (x.ok) {
      TOKEN = pwd;
      document.getElementById("login").style.display = "none";
      document.getElementById("sb").style.display = "flex";
      document.getElementById("main").style.display = "block";
      loadChannels(); loadEvents();
    } else { document.getElementById("lerr").style.display = "block"; }
  }).catch(function(){ document.getElementById("lerr").style.display = "block"; });
}
document.addEventListener("keydown", function(e){ if(e.key==="Enter" && document.getElementById("login").style.display !== "none") doLogin(); });

function sp(name) {
  document.querySelectorAll(".page").forEach(function(p){ p.classList.remove("active"); });
  document.querySelectorAll(".ni").forEach(function(n){ n.classList.remove("active"); });
  var page = document.getElementById("page-" + name);
  if (page) page.classList.add("active");
  var nav = document.querySelector("[data-p='" + name + "']");
  if (nav) nav.classList.add("active");
  if (name === "tickets") loadTickets();
  if (name === "apps") loadApps();
  if (name === "events") loadEvents();
}

function api(method, url, body) {
  var opts = {method:method, headers:{"x-panel-token":TOKEN}};
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(url, opts).then(function(r){ return r.json().then(function(d){ if(!r.ok) throw new Error(d.error||"Ошибка"); return d; }); });
}

function toast(msg, type) {
  type = type || "success";
  var el = document.createElement("div");
  el.className = "toast t" + (type === "success" ? "s" : "e");
  el.textContent = (type === "success" ? "✅ " : "❌ ") + msg;
  document.getElementById("toast").appendChild(el);
  setTimeout(function(){ el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(function(){ el.remove(); },300); }, 3000);
}

function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function doSearch(prefix, q) {
  var drop = document.getElementById(prefix + "-drop");
  clearTimeout(searchTimers[prefix]);
  if (!q.trim()) { drop.style.display = "none"; return; }
  searchTimers[prefix] = setTimeout(function(){
    api("GET", "/api/members?q=" + encodeURIComponent(q)).then(function(members){
      if (!members.length) {
        drop.innerHTML = '<div class="sitem" style="color:var(--muted)">Не найдено</div>';
      } else {
        drop.innerHTML = members.map(function(m){
          return '<div class="sitem" data-id="' + m.id + '" data-tag="' + esc(m.username) + '" onmousedown="event.preventDefault();pickMember(this,&quot;' + prefix + '&quot;)">' + esc(m.username) + '<span class="sid">' + m.id + '</span></div>';
        }).join("");
      }
      drop.style.display = "block";
    }).catch(function(){});
  }, 280);
}

function pickMember(el, prefix) {
  var id = el.getAttribute("data-id");
  var tag = el.getAttribute("data-tag");
  document.getElementById(prefix + "-uid").value = id;
  document.getElementById(prefix + "-search").value = "";
  document.getElementById(prefix + "-drop").style.display = "none";
  document.getElementById(prefix + "-sel-tag").textContent = tag;
  document.getElementById(prefix + "-sel-id").textContent = id;
  document.getElementById(prefix + "-sel").style.display = "flex";
  if (prefix === "warn") loadWarns(id);
}

function clearSel(prefix) {
  document.getElementById(prefix + "-uid").value = "";
  document.getElementById(prefix + "-search").value = "";
  document.getElementById(prefix + "-sel").style.display = "none";
  if (prefix === "warn") document.getElementById("warns-list").innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">Выберите участника</td></tr>';
}

document.addEventListener("click", function(e){
  document.querySelectorAll(".sdrop").forEach(function(d){
    if (!d.parentElement.contains(e.target)) d.style.display = "none";
  });
});

function loadChannels() {
  api("GET", "/api/channels").then(function(chs){
    channels = chs;
    ["ev-channel","ev-postpone-channel","ev-cancel-channel"].forEach(function(id){
      var sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '<option value="">Не отправлять</option>' + chs.map(function(c){ return '<option value="' + c.id + '">#' + esc(c.name) + '</option>'; }).join("");
    });
  }).catch(function(){});
}

function setDur(min) { document.getElementById("mute-dur").value = min; }

function doMute() {
  var userId = document.getElementById("mute-uid").value;
  var reason = document.getElementById("mute-reason").value;
  var durMin = parseInt(document.getElementById("mute-dur").value) || 0;
  if (!userId) return toast("Выберите участника", "error");
  api("POST", "/api/mute", {userId:userId, reason:reason, duration: durMin > 0 ? durMin * 60000 : null})
  .then(function(r){ toast(r.message); }).catch(function(e){ toast(e.message, "error"); });
}

function doUnmute() {
  var userId = document.getElementById("mute-uid").value;
  if (!userId) return toast("Выберите участника", "error");
  api("POST", "/api/unmute", {userId:userId})
  .then(function(r){ toast(r.message); }).catch(function(e){ toast(e.message, "error"); });
}

function doWarn() {
  var userId = document.getElementById("warn-uid").value;
  var reason = document.getElementById("warn-reason").value;
  if (!userId) return toast("Выберите участника", "error");
  api("POST", "/api/warn", {userId:userId, reason:reason})
  .then(function(r){ toast(r.message); loadWarns(userId); document.getElementById("warn-reason").value = ""; })
  .catch(function(e){ toast(e.message, "error"); });
}

function loadWarns(userId) {
  if (!userId || userId.length < 5) return;
  api("GET", "/api/warns/" + userId).then(function(warns){
    var tbody = document.getElementById("warns-list");
    tbody.setAttribute("data-uid", userId);
    if (!warns.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">Варнов нет ✅</td></tr>'; return; }
    tbody.innerHTML = warns.map(function(w, i){
      return '<tr><td><span class="mono">' + (i+1) + '</span></td><td>' + esc(w.reason||"—") + '</td><td style="color:var(--muted2)">' + esc(w.mod_tag||"—") + '</td><td style="color:var(--muted2);font-size:12px">' + new Date(w.timestamp).toLocaleString("ru") + '</td><td><button class="btn bd btn-sm" onclick="removeWarn(this)">Снять</button></td></tr>';
    }).join("");
  }).catch(function(){});
}

function removeWarn(btn) {
  var tbody = document.getElementById("warns-list");
  var userId = tbody.getAttribute("data-uid");
  var num = btn.closest("tr").cells[0].textContent.trim();
  api("DELETE", "/api/warns/" + userId + "/" + num)
  .then(function(){ toast("Варн снят"); loadWarns(userId); })
  .catch(function(e){ toast(e.message, "error"); });
}

function doKick() {
  var userId = document.getElementById("bk-uid").value;
  var reason = document.getElementById("kick-reason").value;
  if (!userId) return toast("Выберите участника", "error");
  if (!confirm("Кикнуть участника?")) return;
  api("POST", "/api/kick", {userId:userId, reason:reason})
  .then(function(r){ toast(r.message); }).catch(function(e){ toast(e.message, "error"); });
}

function doBan() {
  var userId = document.getElementById("bk-uid").value;
  var reason = document.getElementById("ban-reason").value;
  if (!userId) return toast("Выберите участника", "error");
  if (!confirm("ЗАБАНИТЬ? Необратимо!")) return;
  api("POST", "/api/ban", {userId:userId, reason:reason})
  .then(function(r){ toast(r.message); }).catch(function(e){ toast(e.message, "error"); });
}

function doCreateEvent() {
  var name = document.getElementById("ev-name").value.trim();
  var desc = document.getElementById("ev-desc").value.trim();
  var dateStr = document.getElementById("ev-date").value;
  var channelId = document.getElementById("ev-channel").value;
  var organizerId = document.getElementById("org-uid").value.trim();
  if (!name || !dateStr) return toast("Заполните название и дату", "error");
  var timestamp = new Date(dateStr).getTime();
  api("POST", "/api/events", {name:name, description:desc, timestamp:timestamp, channelId:channelId, organizerId:organizerId||undefined})
  .then(function(r){
    toast(r.message);
    document.getElementById("ev-name").value = "";
    document.getElementById("ev-desc").value = "";
    document.getElementById("ev-date").value = "";
    document.getElementById("org-uid").value = "";
    loadEvents();
  }).catch(function(e){ toast(e.message, "error"); });
}

function loadEvents() {
  var wrap = document.getElementById("events-list");
  api("GET", "/api/events").then(function(events){
    if (!events.length) { wrap.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px">Нет предстоящих ивентов</div>'; return; }
    wrap.innerHTML = events.map(function(e){
      var d = new Date(e.date_ts);
      return '<div class="ev-card"><div class="ev-dot"></div><div class="ev-info"><h4>' + esc(e.name) + '</h4><p>' + esc(e.description||"") + ' &bull; ' + d.toLocaleString("ru") + '</p></div><div class="ev-actions"><button class="btn bp btn-sm" onclick="openEvAction(' + e.id + ',\'postpone\')">📅 Перенести</button><button class="btn bd btn-sm" onclick="openEvAction(' + e.id + ',\'cancel\')">❌ Отменить</button></div></div>';
    }).join("");
  }).catch(function(){
    wrap.innerHTML = '<div style="color:var(--red);text-align:center;padding:24px">Ошибка загрузки</div>';
  });
}

function openEvAction(id, action) {
  currentEvId = id;
  document.getElementById("ev-action-title").textContent = action === "postpone" ? "📅 Перенести ивент" : "❌ Отменить ивент";
  document.getElementById("ev-postpone-form").style.display = action === "postpone" ? "block" : "none";
  document.getElementById("ev-cancel-form").style.display   = action === "cancel"   ? "block" : "none";
  ["ev-postpone-channel","ev-cancel-channel"].forEach(function(selId){
    var sel = document.getElementById(selId);
    sel.innerHTML = '<option value="">Не отправлять</option>' + channels.map(function(c){ return '<option value="' + c.id + '">#' + esc(c.name) + '</option>'; }).join("");
  });
  document.querySelectorAll(".page").forEach(function(p){ p.classList.remove("active"); });
  document.getElementById("page-ev-action").classList.add("active");
}

function doPostpone() {
  var newDateStr = document.getElementById("ev-new-date").value;
  var reason = document.getElementById("ev-postpone-reason").value;
  var channelId = document.getElementById("ev-postpone-channel").value;
  if (!newDateStr) return toast("Укажите новую дату", "error");
  var timestamp = new Date(newDateStr).getTime();
  api("POST", "/api/events/" + currentEvId + "/postpone", {timestamp:timestamp, reason:reason, channelId:channelId})
  .then(function(r){ toast(r.message); sp("events"); }).catch(function(e){ toast(e.message, "error"); });
}

function doCancel() {
  var reason = document.getElementById("ev-cancel-reason").value;
  var channelId = document.getElementById("ev-cancel-channel").value;
  if (!confirm("Отменить ивент?")) return;
  api("POST", "/api/events/" + currentEvId + "/cancel", {reason:reason, channelId:channelId})
  .then(function(r){ toast(r.message); sp("events"); }).catch(function(e){ toast(e.message, "error"); });
}

// ── Тикеты ──────────────────────────────────────────────────────────────────
function loadTickets() {
  api("GET", "/api/tickets").then(function(t){
    var tbody = document.getElementById("tickets-list");
    if (!t.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:20px">Нет тикетов</td></tr>'; return; }
    var sm = {open:'<span class="badge bg2">● Открыт</span>',closed:'<span class="badge br2">● Закрыт</span>'};
    tbody.innerHTML = t.map(function(x){
      return '<tr><td><span class="mono">#' + x.id + '</span></td><td>' + esc(x.userTag||"—") + '</td><td>' + esc(x.category||"—") + '</td><td>' + (sm[x.status]||'<span class="badge ba2">'+x.status+'</span>') + '</td><td style="font-size:12px;color:var(--muted2)">' + new Date(x.timestamp).toLocaleString("ru") + '</td><td><button class="btn bp btn-sm" onclick="openTicket(' + x.id + ')">Открыть</button></td></tr>';
    }).join("");
  }).catch(function(){});
}

function openTicket(id) {
  currentTicketId = id;
  api("GET", "/api/tickets").then(function(tickets){
    var ticket = tickets.find(function(t){ return t.id == id; });
    if (!ticket) return toast("Тикет не найден", "error");
    document.getElementById("ticket-detail-title").textContent = "Тикет #" + ticket.id + " — " + (ticket.userTag||"");
    var sm = {open:'<span class="badge bg2">● Открыт</span>',closed:'<span class="badge br2">● Закрыт</span>'};
    document.getElementById("ticket-info").innerHTML =
      '<div class="drow">' +
        '<div><div class="dlabel">Пользователь</div><div class="dval">' + esc(ticket.userTag||"—") + '</div></div>' +
        '<div><div class="dlabel">Категория</div><div class="dval">' + esc(ticket.category||"—") + '</div></div>' +
        '<div><div class="dlabel">Статус</div><div class="dval">' + (sm[ticket.status]||ticket.status) + '</div></div>' +
        '<div><div class="dlabel">Дата</div><div class="dval" style="font-size:12px">' + new Date(ticket.timestamp).toLocaleString("ru") + '</div></div>' +
      '</div>';
    document.getElementById("ticket-reply-msg").value = "";
    document.querySelectorAll(".page").forEach(function(p){ p.classList.remove("active"); });
    document.getElementById("page-ticket-detail").classList.add("active");
  }).catch(function(e){ toast(e.message, "error"); });
}

function replyTicket() {
  var msg = document.getElementById("ticket-reply-msg").value.trim();
  if (!msg) return toast("Введите сообщение", "error");
  api("POST", "/api/tickets/" + currentTicketId + "/reply", {message: msg})
  .then(function(r){ toast(r.message); document.getElementById("ticket-reply-msg").value = ""; })
  .catch(function(e){ toast(e.message, "error"); });
}

// ── Заявки ──────────────────────────────────────────────────────────────────
function loadApps() {
  api("GET", "/api/apps").then(function(a){
    var tbody = document.getElementById("apps-list");
    if (!a.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:20px">Нет заявок</td></tr>'; return; }
    var sm = {pending:'<span class="badge by2">● Ожидает</span>',reviewing:'<span class="badge bb2">● Рассматривается</span>',accepted:'<span class="badge bg2">● Принята</span>',rejected:'<span class="badge br2">● Отклонена</span>'};
    tbody.innerHTML = a.map(function(x){
      return '<tr><td><span class="mono">#' + x.id + '</span></td><td>' + esc(x.userTag||"—") + '</td><td>' + esc(x.posLabel||"—") + '</td><td>' + (sm[x.status]||'<span class="badge ba2">'+x.status+'</span>') + '</td><td style="font-size:12px;color:var(--muted2)">' + new Date(x.timestamp).toLocaleString("ru") + '</td><td><button class="btn bp btn-sm" onclick="openApp(' + x.id + ')">Открыть</button></td></tr>';
    }).join("");
  }).catch(function(){});
}

function openApp(id) {
  currentAppId = id;
  api("GET", "/api/apps").then(function(apps){
    var app = apps.find(function(a){ return a.id == id; });
    if (!app) return toast("Заявка не найдена", "error");
    document.getElementById("app-detail-title").textContent = "Заявка #" + app.id + " — " + (app.posLabel||"");
    var sm = {pending:'<span class="badge by2">● Ожидает</span>',reviewing:'<span class="badge bb2">● Рассматривается</span>',accepted:'<span class="badge bg2">● Принята</span>',rejected:'<span class="badge br2">● Отклонена</span>'};
    var answersHtml = "";
    if (app.answers) {
      var labels = {age:"🎂 Возраст", exp:"🔧 Опыт", time:"⏱️ Время", why:"💬 Почему", ideas:"💡 Идеи", help:"🤝 Помощь", conflict:"⚡ Конфликт"};
      answersHtml = '<div class="answers-block">';
      Object.keys(app.answers).forEach(function(k){
        answersHtml += '<div class="answer-item"><div class="aq">' + (labels[k]||k) + '</div><div class="aa">' + esc(app.answers[k]) + '</div></div>';
      });
      answersHtml += '</div>';
    }
    document.getElementById("app-info").innerHTML =
      '<div class="drow">' +
        '<div><div class="dlabel">Пользователь</div><div class="dval">' + esc(app.userTag||"—") + '</div></div>' +
        '<div><div class="dlabel">Позиция</div><div class="dval">' + esc(app.posLabel||"—") + '</div></div>' +
        '<div><div class="dlabel">Статус</div><div class="dval">' + (sm[app.status]||app.status) + '</div></div>' +
        '<div><div class="dlabel">Дата</div><div class="dval" style="font-size:12px">' + new Date(app.timestamp).toLocaleString("ru") + '</div></div>' +
      '</div>' + answersHtml;
    document.getElementById("app-reply-msg").value = "";
    document.querySelectorAll(".page").forEach(function(p){ p.classList.remove("active"); });
    document.getElementById("page-app-detail").classList.add("active");
  }).catch(function(e){ toast(e.message, "error"); });
}

function replyApp() {
  var msg = document.getElementById("app-reply-msg").value.trim();
  if (!msg) return toast("Введите сообщение", "error");
  api("POST", "/api/apps/" + currentAppId + "/reply", {message: msg})
  .then(function(r){ toast(r.message); document.getElementById("app-reply-msg").value = ""; })
  .catch(function(e){ toast(e.message, "error"); });
}
</script>
</body>
</html>`;
}

module.exports = { init };
