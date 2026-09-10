process.on('uncaughtException', err => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', err => console.error('UNHANDLED:', err));

const config  = require('./config');

config.validate();

const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store   = require('./store');
const db      = require('./database');
const tester  = require('./tester');
const tickets = require('./tickets');
const panel   = require('./panel');
const economy = require('./economy');
const admin   = require('./admin');
const ai      = require('./ai');
const newPosts = require('./new-posts');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.on('error', error => console.error('❌ Ошибка Discord-клиента:', error.message));
client.on('warn', warning => console.warn('⚠️ Discord предупреждение:', warning));
client.on('shardError', error => console.error('❌ Ошибка соединения Discord:', error.message));

const ROLE = {
  DIRECTOR: config.ROLE.DIRECTOR,
  DEPUTY:   config.ROLE.DEPUTY,
  MOD_PLUS: config.ROLE.MOD_PLUS,
  MOD:      config.ROLE.MOD,
  APPS:     config.ROLE.APPS,
  REPRIMAND: config.ROLE.REPRIMAND,
};

const ADMIN_ROLE_ID = config.ADMIN_ROLE_ID;

function hasRole(member, ids) {
  return ids.some(id => member.roles.cache.has(id));
}

function isDirector(member) {
  return hasRole(member, ROLE.DIRECTOR)
    || member.roles.cache.has(ADMIN_ROLE_ID)
    || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function canBan(member) {
  return isDirector(member) || hasRole(member, ROLE.DEPUTY);
}

function canKick(member) {
  return canBan(member) || hasRole(member, ROLE.MOD_PLUS);
}

function canWarnMute(member) {
  return canKick(member) || hasRole(member, ROLE.MOD);
}

function canReprimand(member) {
  return hasRole(member, ROLE.REPRIMAND) || isDirector(member);
}

// ─── Система выговоров (3 типа) ─────────────────────────────────────────────
const REPRIMAND_CHANNEL_ID      = '1538927050193244180';
const REPRIMAND_REMOVED_ROLE_ID = '1479026754483130458';
const REPRIMAND_STRIP_ROLE_IDS  = ['1547489840130560050', '1478315419432386560', '1317767382780870706'];
const REPRIMAND_CMD_ROLE_IDS    = ['1486307269254709248', '1478319008368295977', '1291703538648354867', '1291703232212500510'];

const REPRIMAND_TYPES = {
  'ус': { key: 'ус', name: 'Устный пред',     days: 7,  max: 4 },
  'вг': { key: 'вг', name: 'Выговор',         days: 14, max: 3 },
  'ст': { key: 'ст', name: 'Строгий выговор', days: 30, max: 2 },
};

const REPRIMAND_ALIASES = {
  'ус': 'ус', 'устный': 'ус', 'у': 'ус', 'oral': 'ус',
  'вг': 'вг', 'выговор': 'вг', 'в': 'вг', 'обычный': 'вг',
  'ст': 'ст', 'строгий': 'ст', 'с': 'ст', 'strict': 'ст',
};

function resolveReprimandType(raw) {
  if (!raw) return null;
  return REPRIMAND_TYPES[REPRIMAND_ALIASES[raw.toLowerCase()]] || null;
}

function canUseReprimandCmd(member) {
  return hasRole(member, REPRIMAND_CMD_ROLE_IDS) || canReprimand(member);
}


function canReviewApps(member) {
  return isDirector(member) || hasRole(member, ROLE.APPS);
}

function isEventMod(member) {
  return canKick(member);
}

// Кто может выдавать ивент-бан
function canEventBan(member) {
  return isDirector(member) || hasRole(member, config.EVENT_BAN_MOD_ROLE_IDS);
}

// Поиск участника по ID, упоминанию или нику/имени
async function findMember(guild, query) {
  if (!query) return null;
  const id = query.replace(/\D/g, '');
  if (id.length > 5) {
    const byId = await guild.members.fetch(id).catch(() => null);
    if (byId) return byId;
  }
  const q = query.toLowerCase();
  const cached = guild.members.cache.find(m =>
    m.user.username.toLowerCase() === q ||
    m.displayName.toLowerCase() === q ||
    m.user.tag.toLowerCase() === q
  );
  if (cached) return cached;
  const found = await guild.members.search({ query, limit: 1 }).catch(() => null);
  return found?.first() || null;
}

const eventDialogs = {};

function embed(color, title, description, fields = []) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (description) e.setDescription(description);
  if (fields.length) e.addFields(fields);
  return e;
}

async function sendLog(guild, embedObj) {
  if (!config.LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(config.LOG_CHANNEL_ID);
  if (ch) ch.send({ embeds: [embedObj] });
}

function parseDuration(str) {
  const match = str.match(/^(\d+)(м|ч|д|s|m|h|d)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const map = { 'м':60000,'m':60000,'ч':3600000,'h':3600000,'д':86400000,'d':86400000,'s':1000 };
  return n * (map[unit] || 0);
}

function formatDuration(ms) {
  const d = Math.floor(ms/86400000), h = Math.floor((ms%86400000)/3600000), m = Math.floor((ms%3600000)/60000);
  const parts = [];
  if (d) parts.push(`${d}д`); if (h) parts.push(`${h}ч`); if (m) parts.push(`${m}м`);
  return parts.join(' ') || '<1м';
}

function eventButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event_postpone_${eventId}`).setLabel('📅 Перенести').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`event_cancel_${eventId}`).setLabel('❌ Отменить').setStyle(ButtonStyle.Danger),
  );
}

async function resolveTarget(message, args) {
  if (message.reference) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      const member = await message.guild.members.fetch(replied.author.id).catch(() => null);
      return { member, user: replied.author, id: replied.author.id };
    } catch {}
  }
  const mentioned = message.mentions.members.first();
  if (mentioned) return { member: mentioned, user: mentioned.user, id: mentioned.id };
  const id = args[0]?.replace(/\D/g, '');
  if (id && id.length > 5) {
    const member = await message.guild.members.fetch(id).catch(() => null);
    const user = member?.user || await client.users.fetch(id).catch(() => null);
    return { member, user, id };
  }
  return null;
}

function shiftTarget(args) {
  if (!args.length) return args;
  if (args[0].match(/^<@!?\d+>$/) || args[0].match(/^\d{5,}$/)) return args.slice(1);
  return args;
}

setInterval(async () => {
  const now = Date.now();
  const events = db.getAllActiveEvents();
  for (const ev of events) {
    const guild = client.guilds.cache.get(ev.guild_id);
    if (!guild) continue;
    const channel = ev.channel_id ? guild.channels.cache.get(ev.channel_id) : null;
    if (!ev.pinged_before && ev.date_ts - now <= 15 * 60 * 1000 && ev.date_ts > now) {
      db.updateEvent(ev.id, { pinged_before: true });
      if (channel) {
        const organizers = (ev.organizer_ids || [ev.creator_id]).map(id => `<@${id}>`).join(' ');
        await channel.send({
          content: organizers,
          embeds: [embed(0xfee75c, `⏰ Ивент начнётся через 15 минут!`, `**${ev.name}** начнётся <t:${Math.floor(ev.date_ts/1000)}:R>!\nОрганизаторы, приготовьтесь! 🎉`)]
        }).catch(() => {});
      }
    }
    if (!ev.deleted_after && now >= ev.date_ts + 15 * 60 * 1000) {
      db.updateEvent(ev.id, { deleted_after: true, status: 'finished' });
      if (channel && ev.message_id) {
        const msg = await channel.messages.fetch(ev.message_id).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }
  }
}, 60_000);

setInterval(async () => {
  const expired = db.getExpiredPunishments();
  for (const p of expired) {
    const guild = client.guilds.cache.get(p.guild_id);
    if (!guild) continue;
    try {
      if (p.type === 'mute') {
        const member = await guild.members.fetch(p.user_id).catch(() => null);
        if (member) {
          await member.roles.remove(config.MUTE_ROLE_ID);
          await sendLog(guild, embed(0x57f287, '🔊 Авто-размут', `<@${p.user_id}> — время мута истекло`));
          await member.user.send({ embeds: [embed(0x57f287, '🔊 Ваш мут снят', `Срок вашего мута на сервере **${guild.name}** истёк и он был автоматически снят.`)] }).catch(() => {});
        }
      } else if (p.type === 'ban') {
        await guild.bans.remove(p.user_id).catch(() => {});
        await sendLog(guild, embed(0x57f287, '🔓 Авто-разбан', `<@${p.user_id}> — время бана истекло`));
      } else if (p.type === 'eventban') {
        const member = await guild.members.fetch(p.user_id).catch(() => null);
        if (member) await member.roles.remove(config.EVENT_BAN_ROLE_ID).catch(() => {});
        await sendLog(guild, embed(0x57f287, '✅ Авто-снятие ивент-бана', `<@${p.user_id}> — срок ивент-бана истёк`));
        const u = await client.users.fetch(p.user_id).catch(() => null);
        if (u) await u.send({ embeds: [embed(0x57f287, '✅ Ивент-бан снят', `Срок вашего ивент-бана на сервере **${guild.name}** истёк.`)] }).catch(() => {});
      }
    } catch(e) {}
    db.removePunishment(p.id);
  }
}, 30_000);

setInterval(async () => {
  const expired = db.getExpiredReprimands();
  for (const r of expired) {
    db.removeReprimandById(r.id);
    const guild = client.guilds.cache.get(r.guild_id);
    if (!guild) continue;
    await sendLog(guild, embed(0x57f287, '✅ Авто-снятие выговора', `Выговор у <@${r.user_id}> истёк\n**Причина выговора:** ${r.reason}`));
    const user = await client.users.fetch(r.user_id).catch(() => null);
    if (user) await user.send({ embeds: [embed(0x57f287, '✅ Ваш выговор снят', `Срок вашего выговора на сервере **${guild.name}** истёк и он был автоматически снят.\n**Причина выговора:** ${r.reason}`)] }).catch(() => {});
  }
}, 60_000);

client.on('guildMemberAdd', async (member) => {
  if (!config.WELCOME_CHANNEL_ID) return;
  const ch = member.guild.channels.cache.get(config.WELCOME_CHANNEL_ID);
  if (!ch) return;
  ch.send({ embeds: [embed(0x5865f2, '👋 Добро пожаловать!', `Привет, <@${member.id}>! Ты ${member.guild.memberCount}-й участник сервера **${member.guild.name}**.`)] });
  if (config.MEMBER_ROLE_ID) await member.roles.add(config.MEMBER_ROLE_ID).catch(() => {});
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const { customId, member, guild } = interaction;
  if (!customId.startsWith('event_postpone_') && !customId.startsWith('event_cancel_')) return;

  if (!isEventMod(member)) return interaction.reply({ content: '❌ Только ивент-модеры могут это делать!', ephemeral: true });

  const isPostpone = customId.startsWith('event_postpone_');
  const eventId = parseInt(customId.replace('event_postpone_', '').replace('event_cancel_', ''));
  const ev = db.getEventById(eventId);
  if (!ev) return interaction.reply({ content: '❌ Ивент не найден', ephemeral: true });
  if (ev.status !== 'active') return interaction.reply({ content: '❌ Ивент уже отменён или перенесён', ephemeral: true });

  eventDialogs[interaction.user.id] = {
    type: isPostpone ? 'postpone' : 'cancel',
    eventId, guildId: guild.id,
    channelId: interaction.channel.id,
    messageId: ev.message_id,
    eventName: ev.name,
    originalDesc: ev.description,
    originalTs: ev.date_ts,
  };

  await interaction.reply({
    content: isPostpone
      ? `📅 **На какое время переносим ивент "${ev.name}"?**\nНапиши новую дату, время и причину:\n\`ГГГГ-ММ-ДД ЧЧ:ММ причина\`\nПример: \`2025-06-20 21:00 технические проблемы\``
      : `❌ **Укажи причину отмены ивента "${ev.name}":**\nНапиши причину в этом канале.`,
    ephemeral: true,
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ИИ-канал: отвечаем через Groq и дальше сообщение не обрабатываем
  if (await ai.handleMessage(message)) return;

  if (message.guild) {
    const dialog = eventDialogs[message.author.id];
    if (dialog && message.channel.id === dialog.channelId) {
      delete eventDialogs[message.author.id];
      const ev = db.getEventById(dialog.eventId);
      if (!ev) return message.reply('❌ Ивент не найден');
      const channel = message.guild.channels.cache.get(dialog.channelId);

      if (dialog.type === 'cancel') {
        const reason = message.content;
        db.updateEvent(dialog.eventId, { status: 'cancelled' });
        if (channel && ev.message_id) {
          const origMsg = await channel.messages.fetch(ev.message_id).catch(() => null);
          if (origMsg) await origMsg.delete().catch(() => {});
        }
        await message.delete().catch(() => {});
        await sendLog(message.guild, embed(0xed4245, '❌ Ивент отменён', `${message.author.tag} отменил ивент **${ev.name}**.\n**Причина:** ${reason}\n**Изначальная дата:** <t:${Math.floor(ev.date_ts/1000)}:F>`));
      } else {
        const parts = message.content.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*(.*)/s);
        if (!parts) return message.reply('❌ Неверный формат! Используй: `ГГГГ-ММ-ДД ЧЧ:ММ причина`');
        const newDate = new Date(parts[1] + ':00.000+03:00');
        if (isNaN(newDate)) return message.reply('❌ Неверная дата!');
        const reason = parts[2] || 'Без причины';
        const newTs = Math.floor(newDate.getTime() / 1000);
        const organizers = (ev.organizer_ids || [ev.creator_id]).map(id => `<@${id}>`).join(', ');
        db.updateEvent(dialog.eventId, { date_ts: newDate.getTime(), pinged_before: false, deleted_after: false });
        const e = embed(0xfee75c, `📅 Ивент перенесён: ${ev.name}`, ev.description)
          .addFields(
            { name: '⏰ Новая дата', value: `<t:${newTs}:F> (<t:${newTs}:R>)`, inline: false },
            { name: '👥 Организаторы', value: organizers, inline: true }
          );
        if (channel && ev.message_id) {
          const origMsg = await channel.messages.fetch(ev.message_id).catch(() => null);
          if (origMsg) await origMsg.edit({ embeds: [e], components: [eventButtons(dialog.eventId)] }).catch(() => {});
        }
        await message.delete().catch(() => {});
        await sendLog(message.guild, embed(0xfee75c, '📅 Ивент перенесён', `${message.author.tag} перенёс **${ev.name}** на <t:${newTs}:F>.\n**Причина:** ${reason}`));
      }
      return;
    }
  }

  if (!message.guild) return;
  const body = config.stripPrefix(message.content);
  if (body === null) return;

  const args = body.trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  console.log(`[CMD] "${cmd}" от ${message.author.tag}`);
  const member = message.member;
  const guild  = message.guild;

  if (cmd === 'помощь' || cmd === 'help') {
    const e = embed(0x5865f2, '📖 Список команд', 'Все доступные команды бота:\n*Работают на русском и английском. Цель: @пинг, ID или ответ на сообщение.*')
      .addFields(
         { name: '🛡️ Модерация', value: '`!warn` `!mute` `!unmute` `!kick` `!ban` `!unban` `!purge`\n`!view-case` `!remove-case` `!punishments` `!reason`\n`!lock-down` `!slow-mode` `!deleted-message-log` `!edited-message-log`' },
         { name: '💰 Экономика', value: '`!money` `!leaderboard` `!work` `!daily` `!weekly`\n`!collect` `!collect-income` `!deposit` `!shop` `!buy` `!inventory`\n`/role-sell` `/role-unsell` `/role-listings`\n`!profile` `!rep` `!rank`' },
         { name: '⚙️ Администраторы', value: '`!add-money` `!remove-money` `!reset-money` `!reset-economy`\n`!set-currency` `!economy-stats` `!enable` `!disable`\n`!permissions` `!channel-override` `!command-status`' },
         { name: '👨‍💻 Разработчики', value: '`!bot-info` `!reload` `!maintenance` `!logs` `!debug`\n`!config` `!database-stats` `!backup` `!permissions-admin`\n`!new` / `!новое` — создать публикацию' },
        { name: '🎉 Ивенты', value: '`!ивент/event` `!скоро/upcoming`\n`!event ban <ID/ник> <дней> <причина>` `!event unban <ID/ник>`' },
        { name: '📊 Разное', value: '`!опрос/poll` `!инфо/info` `!стат/stat`' },
        { name: '📋 Заявки', value: '`!заявки-меню` `!заявки`' },
        { name: '🎫 Тикеты', value: '`!тикет-меню`' },
        { name: '💡 Примеры', value: '`!выговор ус @юзер причина` *(Устный пред — 7 дней, 4 = снятие)*\n`!выговор вг @юзер причина` *(Выговор — 14 дней, 3 = снятие)*\n`!выговор ст @юзер причина` *(Строгий — 30 дней, 2 = снятие)*\n`!мут @юзер 1ч спам`\n`!ban 123456789 1d flood`' },

      );
    return message.channel.send({ embeds: [e] });
  }

  if (cmd === 'пинг' || cmd === 'ping') {
    return message.reply('🏓 Понг! Бот получает сообщения.');
  }

  if (cmd === 'варн' || cmd === 'warn') {
    if (!canWarnMute(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    if (!t || !t.member) return message.reply('❌ Укажи пользователя: `!варн @юзер [причина]` или ответь на сообщение');
    const restArgs = shiftTarget(args);
    const reason = restArgs.join(' ') || 'Без причины';
    const warnCount = db.addWarn(guild.id, t.id, message.author.id, message.author.tag, reason);
    const e = embed(0xfee75c, '⚠️ Предупреждение', `**${t.user.tag}** получил предупреждение`)
      .addFields({ name: 'Причина', value: reason, inline: true }, { name: 'Модератор', value: message.author.tag, inline: true }, { name: 'Всего варнов', value: `${warnCount}`, inline: true });
    message.channel.send({ embeds: [e] });
    await sendLog(guild, e);
    await t.user.send({ embeds: [embed(0xfee75c, '⚠️ Вы получили предупреждение', `Вы получили предупреждение на сервере **${guild.name}**`)
      .addFields({ name: '📋 Причина', value: reason, inline: true }, { name: '📊 Всего варнов', value: `${warnCount}`, inline: true }, { name: '👤 Модератор', value: message.author.tag, inline: true })] }).catch(() => {});
    if (warnCount >= 5 && canKick(member)) {
      await t.member.kick('Авто-кик: 5 варнов').catch(() => {});
      message.channel.send({ embeds: [embed(0xed4245, '🦵 Авто-кик', `<@${t.id}> получил 5 варнов и был кикнут`)] });
    } else if (warnCount >= 3) {
      await t.member.roles.add(config.MUTE_ROLE_ID).catch(() => {});
      db.addPunishment(guild.id, t.id, 'mute', Date.now() + 3600000);
      message.channel.send({ embeds: [embed(0xfee75c, '🔇 Авто-мут', `<@${t.id}> получил 3 варна — мут на 1 час`)] });
    }
    return;
  }

  if (cmd === 'варны' || cmd === 'warns') {
    const t = await resolveTarget(message, args);
    const targetId = t?.id || member.id;
    const targetTag = t?.user?.tag || message.author.tag;
    const warns = db.getWarns(guild.id, targetId);
    if (!warns.length) return message.reply(`✅ У <@${targetId}> нет предупреждений`);
    const list = warns.map((w, i) => `**${i+1}.** ${w.reason} — *${w.mod_tag}* <t:${Math.floor(w.timestamp/1000)}:R>`).join('\n');
    return message.channel.send({ embeds: [embed(0xfee75c, `⚠️ Варны ${targetTag}`, list).addFields({ name: 'Всего', value: `${warns.length}`, inline: true })] });
  }

  if (cmd === 'снятьварн' || cmd === 'removewarn') {
    if (!canWarnMute(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    if (!t) return message.reply('❌ Укажи пользователя');
    const restArgs = shiftTarget(args);
    const removed = db.removeWarn(guild.id, t.id, parseInt(restArgs[0]) || null);
    if (!removed) return message.reply('❌ Варн не найден');
    return message.reply({ embeds: [embed(0x57f287, '✅ Варн снят', `Предупреждение у <@${t.id}> снято`)] });
  }

  if (cmd === 'выговор' || cmd === 'reprimand') {
    if (!canUseReprimandCmd(member)) return message.reply('❌ Нет прав на выдачу выговоров.');

    const type = resolveReprimandType(args[0]);
    if (!type) {
      return message.reply('❌ Укажи тип: `!выговор ус|вг|ст @юзер причина`\n`ус` — Устный пред (7 дней), `вг` — Выговор (14 дней), `ст` — Строгий выговор (30 дней)');
    }

    const rest = args.slice(1);
    const t = await resolveTarget(message, rest);
    if (!t || !t.id) return message.reply('❌ Укажи пользователя: `!выговор ус @юзер причина`');

    const reason = shiftTarget(rest).join(' ') || 'Без причины';
    const expiresAt = Date.now() + type.days * 86400000;
    db.addReprimand(guild.id, t.id, message.author.id, message.author.tag, reason, expiresAt, type.key);

    const count = db.countReprimandsByKind(guild.id, t.id, type.key);
    const score = `${type.name} (${count}/${type.max})`;
    const reached = count >= type.max;

    const channel = guild.channels.cache.get(REPRIMAND_CHANNEL_ID)
      || await guild.channels.fetch(REPRIMAND_CHANNEL_ID).catch(() => null);

    const text = `<@${t.id}> получает выговор ${score} за ${reason}`;
    if (channel) await channel.send({ content: text, allowedMentions: { users: [t.id] } }).catch(() => {});

    if (reached) {
      if (channel) {
        await channel.send({ content: `${text} Снятие`, allowedMentions: { users: [t.id] } }).catch(() => {});
      }
      const target = t.member || await guild.members.fetch(t.id).catch(() => null);
      if (target) {
        for (const rid of REPRIMAND_STRIP_ROLE_IDS) {
          if (target.roles.cache.has(rid)) await target.roles.remove(rid).catch(() => {});
        }
        await target.roles.add(REPRIMAND_REMOVED_ROLE_ID).catch(() => {});
      }
      db.clearReprimandsByKind(guild.id, t.id, type.key);
    }

    const e = embed(0xff7f00, '📢 Выговор', `<@${t.id}> получает выговор **${score}**`)
      .addFields(
        { name: 'Тип', value: type.name, inline: true },
        { name: 'Снимается через', value: `${type.days} дн.`, inline: true },
        { name: 'Модератор', value: message.author.tag, inline: true },
        { name: 'Причина', value: reason, inline: false },
        ...(reached ? [{ name: '🚨 Снятие', value: 'Лимит достигнут — роли сняты, выдана роль снятия.', inline: false }] : []),
      );
    message.channel.send({ embeds: [e] });
    await sendLog(guild, e);

    if (t.user) await t.user.send({ embeds: [embed(0xff7f00, '📢 Вы получили выговор', `Сервер **${guild.name}**`)
      .addFields(
        { name: '📋 Тип', value: score, inline: true },
        { name: '⏱️ Снимается через', value: `${type.days} дн.`, inline: true },
        { name: '👤 Модератор', value: message.author.tag, inline: true },
        { name: '📝 Причина', value: reason, inline: false },
        ...(reached ? [{ name: '🚨 Снятие', value: 'Вы сняты с должности.', inline: false }] : []),
      )] }).catch(() => {});
    return;
  }


  if (cmd === 'выговоры' || cmd === 'reprimands') {
    const t = await resolveTarget(message, args);
    if (t?.id) {
      const reps = db.getReprimands(guild.id, t.id);
      if (!reps.length) return message.reply(`✅ У <@${t.id}> нет выговоров`);
      const list = reps.map((r, i) => {
        const expiry = r.expires_at ? ` *(истекает <t:${Math.floor(r.expires_at/1000)}:R>)*` : ' *(постоянный)*';
        return `**${i+1}.** ${r.reason} — *${r.mod_tag}* <t:${Math.floor(r.timestamp/1000)}:R>${expiry}`;
      }).join('\n');
      return message.channel.send({ embeds: [embed(0xff7f00, `📢 Выговоры ${t.user?.tag || t.id}`, list).addFields({ name: 'Всего', value: `${reps.length}`, inline: true })] });
    } else {
      if (!canReprimand(member)) return message.reply('❌ Нет прав!');
      const allReps = db.getAllReprimands(guild.id);
      if (!allReps.length) return message.reply('✅ На сервере нет выговоров');
      const grouped = {};
      allReps.forEach(r => { if (!grouped[r.user_id]) grouped[r.user_id] = []; grouped[r.user_id].push(r); });
      const list = Object.entries(grouped)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 20)
        .map(([uid, reps]) => `<@${uid}> — **${reps.length}** выговор${reps.length === 1 ? '' : reps.length < 5 ? 'а' : 'ов'}`)
        .join('\n');
      return message.channel.send({ embeds: [embed(0xff7f00, `📢 Все выговоры на сервере`, list)] });
    }
  }

  if (cmd === 'снятьвыговор' || cmd === 'removereprimand') {
    if (!canReprimand(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    if (!t) return message.reply('❌ Укажи пользователя');
    const restArgs = shiftTarget(args);
    const removed = db.removeReprimand(guild.id, t.id, parseInt(restArgs[0]) || null);
    if (!removed) return message.reply('❌ Выговор не найден');
    message.reply({ embeds: [embed(0x57f287, '✅ Выговор снят', `Выговор у <@${t.id}> снят`)] });
    if (t.user) await t.user.send({ embeds: [embed(0x57f287, '✅ Ваш выговор снят', `Ваш выговор на сервере **${guild.name}** был снят модератором **${message.author.tag}**.`)] }).catch(() => {});
    return;
  }

  if (cmd === 'мут' || cmd === 'mute') {
    if (!canWarnMute(member)) return message.reply('❌ Нет прав!');
    if (!config.MUTE_ROLE_ID) return message.reply('❌ MUTE_ROLE_ID не настроен');
    const t = await resolveTarget(message, args);
    if (!t || !t.member) return message.reply('❌ Укажи пользователя: `!мут @юзер [время] [причина]` или ответь на сообщение');
    if (t.id === guild.ownerId) return message.reply('❌ Нельзя замутить владельца сервера!');
    if (t.member.roles.highest.position >= member.roles.highest.position) return message.reply('❌ Нельзя замутить пользователя с ролью выше или равной твоей!');
    const restArgs = shiftTarget(args);
    let duration = parseDuration(restArgs[0] || '');
    let reason = duration ? restArgs.slice(1).join(' ') || 'Без причины' : restArgs.join(' ') || 'Без причины';
    await t.member.roles.add(config.MUTE_ROLE_ID);
    const expiresAt = duration ? Date.now() + duration : null;
    if (expiresAt) db.addPunishment(guild.id, t.id, 'mute', expiresAt);
    const e = embed(0xfee75c, '🔇 Мут', `<@${t.id}> замучен`)
      .addFields({ name: 'Причина', value: reason, inline: true }, { name: 'Время', value: duration ? formatDuration(duration) : '∞', inline: true }, { name: 'Модератор', value: message.author.tag, inline: true });
    message.channel.send({ embeds: [e] });
    await sendLog(guild, e);
    await t.user.send({ embeds: [embed(0xfee75c, '🔇 Вы получили мут', `Вам выдан мут на сервере **${guild.name}**`)
      .addFields({ name: '📋 Причина', value: reason, inline: true }, { name: '⏱️ Срок', value: duration ? formatDuration(duration) : '∞ (постоянный)', inline: true }, { name: '👤 Модератор', value: message.author.tag, inline: true })] }).catch(() => {});
    return;
  }

  if (cmd === 'размут' || cmd === 'unmute') {
    if (!canWarnMute(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    if (!t || !t.member) return message.reply('❌ Укажи пользователя');
    await t.member.roles.remove(config.MUTE_ROLE_ID).catch(() => {});
    db.removePunishmentByUser(guild.id, t.id, 'mute');
    const e = embed(0x57f287, '🔊 Размут', `<@${t.id}> размучен`);
    message.channel.send({ embeds: [e] });
    await sendLog(guild, e);
    await t.user.send({ embeds: [embed(0x57f287, '🔊 Ваш мут снят', `Ваш мут на сервере **${guild.name}** был снят модератором **${message.author.tag}**.`)] }).catch(() => {});
    return;
  }

  if (cmd === 'муты' || cmd === 'mutes') {
    if (!canWarnMute(member)) return message.reply('❌ Нет прав!');
    const activeMutes = db.getActivePunishments(guild.id, 'mute');
    if (!activeMutes || !activeMutes.length) {
      return message.channel.send({ embeds: [embed(0x57f287, '🔇 Активные муты', 'Нет активных мутов на сервере ✅')] });
    }
    const list = activeMutes.map((p, i) => {
      const until = p.expires_at ? `до <t:${Math.floor(p.expires_at/1000)}:R>` : '∞ (навсегда)';
      return `**${i+1}.** <@${p.user_id}> — ${until}`;
    }).join('\n');
    return message.channel.send({ embeds: [embed(0xfee75c, `🔇 Активные муты на сервере (${activeMutes.length})`, list)] });
  }

  if (cmd === 'кик' || cmd === 'kick') {
    if (!canKick(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    if (!t || !t.member) return message.reply('❌ Укажи пользователя: `!кик @юзер [причина]` или ответь на сообщение');
    if (t.id === guild.ownerId) return message.reply('❌ Нельзя кикнуть владельца сервера!');
    if (t.member.roles.highest.position >= member.roles.highest.position) return message.reply('❌ Нельзя кикнуть пользователя с ролью выше или равной твоей!');
    const restArgs = shiftTarget(args);
    const reason = restArgs.join(' ') || 'Без причины';
    await t.member.kick(reason);
    const e = embed(0xed4245, '🦵 Кик', `**${t.user.tag}** кикнут`)
      .addFields({ name: 'Причина', value: reason, inline: true }, { name: 'Модератор', value: message.author.tag, inline: true });
    message.channel.send({ embeds: [e] });
    return sendLog(guild, e);
  }

  if (cmd === 'бан' || cmd === 'ban') {
    if (!canBan(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    if (!t || !t.id) return message.reply('❌ Укажи пользователя: `!бан @юзер [время] [причина]` или ответь на сообщение');
    if (t.id === guild.ownerId) return message.reply('❌ Нельзя забанить владельца сервера!');
    if (t.member && t.member.roles.highest.position >= member.roles.highest.position) return message.reply('❌ Нельзя забанить пользователя с ролью выше или равной твоей!');
    const restArgs = shiftTarget(args);
    let duration = parseDuration(restArgs[0] || '');
    let reason = duration ? restArgs.slice(1).join(' ') || 'Без причины' : restArgs.join(' ') || 'Без причины';
    await guild.members.ban(t.id, { reason });
    const expiresAt = duration ? Date.now() + duration : null;
    if (expiresAt) db.addPunishment(guild.id, t.id, 'ban', expiresAt);
    const e = embed(0xed4245, '🔨 Бан', `**${t.user?.tag || t.id}** забанен`)
      .addFields({ name: 'Причина', value: reason, inline: true }, { name: 'Время', value: duration ? formatDuration(duration) : '∞', inline: true }, { name: 'Модератор', value: message.author.tag, inline: true });
    message.channel.send({ embeds: [e] });
    return sendLog(guild, e);
  }

  if (cmd === 'разбан' || cmd === 'unban') {
    if (!canBan(member)) return message.reply('❌ Нет прав!');
    const userId = args[0]?.replace(/\D/g, '');
    if (!userId) return message.reply('❌ Укажи ID: `!разбан [ID]`');
    await guild.bans.remove(userId).catch(() => message.reply('❌ Пользователь не забанен'));
    db.removePunishmentByUser(guild.id, userId, 'ban');
    const e = embed(0x57f287, '🔓 Разбан', `<@${userId}> разбанен`);
    message.channel.send({ embeds: [e] });
    return sendLog(guild, e);
  }

  if (cmd === 'очистить' || cmd === 'clear' || cmd === 'purge') {
    if (!isDirector(member)) return message.reply('❌ Нет прав!');
    const amount = Math.min(parseInt(args[0]) || 5, 99);
    await message.channel.bulkDelete(amount + 1, true);
    const msg = await message.channel.send({ embeds: [embed(0x57f287, '🗑️ Очищено', `Удалено **${amount}** сообщений`)] });
    setTimeout(() => msg.delete().catch(() => {}), 3000);
    return sendLog(guild, embed(0x57f287, '🗑️ Очистка', `${message.author.tag} удалил ${amount} сообщений в <#${message.channel.id}>`));
  }

  if (cmd === 'роль' || cmd === 'role') {
    if (!isDirector(member)) return message.reply('❌ Нет прав!');
    const t = await resolveTarget(message, args);
    const role = message.mentions.roles.first();
    if (!t || !t.member || !role) return message.reply('❌ Укажи пользователя и роль: `!роль @юзер @роль`');
    if (t.member.roles.cache.has(role.id)) {
      await t.member.roles.remove(role);
      return message.reply({ embeds: [embed(0xfee75c, '➖ Роль снята', `Роль **${role.name}** снята с <@${t.id}>`)] });
    } else {
      await t.member.roles.add(role);
      return message.reply({ embeds: [embed(0x57f287, '➕ Роль выдана', `Роль **${role.name}** выдана <@${t.id}>`)] });
    }
  }

  if ((cmd === 'ивент' || cmd === 'event') && ['ban', 'бан', 'unban', 'разбан'].includes((args[0] || '').toLowerCase())) {
    const sub = args.shift().toLowerCase();
    const isUnban = sub === 'unban' || sub === 'разбан';
    if (!canEventBan(member)) return message.reply('❌ Нет прав на ивент-бан!');
    const roleId = config.EVENT_BAN_ROLE_ID;
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return message.reply('❌ Роль ивент-бана не найдена на сервере.');

    const target = message.mentions.members.first() || await findMember(guild, args[0]);
    if (!target) return message.reply(`❌ Пользователь не найден. Формат: \`!event ban <ID или ник> <дней> <причина>\``);
    args.shift();

    if (isUnban) {
      await target.roles.remove(role).catch(() => {});
      db.removePunishmentByUser(guild.id, target.id, 'eventban');
      const e = embed(0x57f287, '✅ Ивент-бан снят', `С <@${target.id}> снят ивент-бан`)
        .addFields({ name: 'Модератор', value: message.author.tag, inline: true });
      message.channel.send({ embeds: [e] });
      return sendLog(guild, e);
    }

    const days = parseInt(args[0], 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return message.reply('❌ Укажи количество дней числом: `!event ban <ID или ник> <дней> <причина>`');
    }
    args.shift();
    const reason = args.join(' ') || 'Без причины';
    const expiresAt = Date.now() + days * 86400000;

    await target.roles.add(role, reason).catch(() => null);
    db.removePunishmentByUser(guild.id, target.id, 'eventban');
    db.addPunishment(guild.id, target.id, 'eventban', expiresAt);

    const ts = Math.floor(expiresAt / 1000);
    const e = embed(0xed4245, '🚫 Ивент-бан', `**${target.user.tag}** получил ивент-бан`)
      .addFields(
        { name: 'Срок', value: `${days} дн. (до <t:${ts}:f>)`, inline: true },
        { name: 'Причина', value: reason, inline: true },
        { name: 'Модератор', value: message.author.tag, inline: true },
      );
    await target.user.send({ embeds: [embed(0xed4245, '🚫 Вам выдан ивент-бан', `Сервер **${guild.name}**\n**Срок:** ${days} дн. (до <t:${ts}:f>)\n**Причина:** ${reason}`)] }).catch(() => {});
    message.channel.send({ embeds: [e] });
    return sendLog(guild, e);
  }

  if (cmd === 'ивент' || cmd === 'event') {
    if (!isEventMod(member)) return message.reply('❌ Нет прав! Нужна роль ивент-модера.');
    const parts = args.join(' ').split('|').map(s => s.trim());
    if (parts.length < 3) return message.reply('❌ Формат: `!ивент Название | Описание | ГГГГ-ММ-ДД ЧЧ:ММ`');
    const [name, desc, datePart] = parts;
    const dateStr = datePart.substring(0, 16).trim();
    const date = new Date(dateStr + ':00.000+03:00');
    if (isNaN(date)) return message.reply('❌ Неверный формат даты. Используй: `ГГГГ-ММ-ДД ЧЧ:ММ`');
    const organizerIds = [message.author.id, ...message.mentions.users.map(u => u.id)].filter((v, i, a) => a.indexOf(v) === i);
    const eventId = db.addEvent(guild.id, name, desc, date.getTime(), organizerIds);
    const timestamp = Math.floor(date.getTime() / 1000);
    const organizersText = organizerIds.map(id => `<@${id}>`).join(', ');
    const e = embed(0x5865f2, `📅 Новый ивент: ${name}`, desc)
      .addFields(
        { name: '⏰ Дата', value: `<t:${timestamp}:F> (<t:${timestamp}:R>)`, inline: false },
        { name: '👤 Организаторы', value: organizersText, inline: true }
      );
    await message.delete().catch(() => {});
    const sentMsg = await message.channel.send({ embeds: [e], components: [eventButtons(eventId)] });
    db.updateEvent(eventId, { message_id: sentMsg.id, channel_id: message.channel.id });
    return sendLog(guild, embed(0x5865f2, '📅 Создан ивент', `${message.author.tag} создал ивент **${name}** на <t:${timestamp}:F>\nОрганизаторы: ${organizersText}`));
  }

  if (cmd === 'скоро' || cmd === 'upcoming') {
    const events = db.getUpcomingEvents(guild.id);
    if (!events.length) return message.reply('📅 Нет предстоящих ивентов');
    const e = embed(0x5865f2, '📅 Предстоящие ивенты', '');
    for (const ev of events.slice(0, 5)) {
      const ts = Math.floor(ev.date_ts / 1000);
      e.addFields({ name: `🎉 ${ev.name}`, value: `${ev.description}\n⏰ <t:${ts}:F> (<t:${ts}:R>)` });
    }
    return message.channel.send({ embeds: [e] });
  }

  if (cmd === 'опрос' || cmd === 'poll') {
    const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 3) return message.reply('❌ Формат: `!опрос Вопрос | Вариант1 | Вариант2 | ...`');
    const question = parts[0];
    const options  = parts.slice(1);
    const emojis   = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const e = embed(0x5865f2, `📊 Опрос: ${question}`, options.map((o,i) => `${emojis[i]} ${o}`).join('\n'))
      .setFooter({ text: `Опрос от ${message.author.tag}` });
    await message.delete().catch(() => {});
    const msg = await message.channel.send({ embeds: [e] });
    for (let i = 0; i < Math.min(options.length, 10); i++) await msg.react(emojis[i]);
    return;
  }

  if (cmd === 'инфо' || cmd === 'info') {
    const t = await resolveTarget(message, args);
    const target = t?.member || member;
    const targetUser = t?.user || message.author;
    const warns  = db.getWarns(guild.id, target.id);
    const reps   = db.getReprimands(guild.id, target.id);
    const roles  = target.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(', ') || 'Нет';
    const e = embed(0x5865f2, `👤 ${targetUser.tag}`, '')
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: 'ID', value: target.id, inline: true },
        { name: 'На сервере с', value: `<t:${Math.floor(target.joinedTimestamp/1000)}:D>`, inline: true },
        { name: 'Аккаунт создан', value: `<t:${Math.floor(targetUser.createdTimestamp/1000)}:D>`, inline: true },
        { name: 'Варны', value: `${warns.length}`, inline: true },
        { name: 'Выговоры', value: `${reps.length}`, inline: true },
        { name: 'Роли', value: roles }
      );
    return message.channel.send({ embeds: [e] });
  }

  if (cmd === 'стат' || cmd === 'stat') {
    const total = guild.memberCount;
    const bots  = guild.members.cache.filter(m => m.user.bot).size;
    const e = embed(0x5865f2, `📊 Статистика: ${guild.name}`, '')
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: '👥 Участники', value: `${total - bots}`, inline: true },
        { name: '🤖 Боты', value: `${bots}`, inline: true },
        { name: '💬 Каналы', value: `${guild.channels.cache.size}`, inline: true },
        { name: '📅 Создан', value: `<t:${Math.floor(guild.createdTimestamp/1000)}:D>`, inline: true }
      );
    return message.channel.send({ embeds: [e] });
  }

  if (cmd === 'заявки-меню') {
    if (!isDirector(member)) return message.reply('❌ Нет прав!');
    return tester.handleMenu(message);
  }

  if (cmd === 'тикет-меню') {
    if (!canWarnMute(member)) return message.reply('❌ Нет прав!');
    return tickets.handleMenu(message);
  }

  if (cmd === 'заявки') {
    if (!canReviewApps(member)) return message.reply('❌ Нет прав!');
    return tester.handleList(message);
  }
});

client.once('clientReady', async () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);
  console.log(`✅ Подключён к серверам: ${client.guilds.cache.map(guild => `${guild.name} (${guild.id})`).join(', ') || 'нет'}`);
  console.log(`ℹ️ Префиксы команд: ${config.prefixes().map(p => `"${p}"`).join(', ')}`);
  console.log('ℹ️ Если !пинг не отвечает, включи Message Content Intent в Discord Developer Portal → Bot → Privileged Gateway Intents.');
  db.init();
  tester.init(client, config);
  tickets.init(client, config);
  panel.init(client, config, db);
  economy.init(client, config);
  admin.init(client, config, db, economy);
  newPosts.init(client, config);

  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetch().catch(() => {});
    console.log(`✅ Загружено ${guild.memberCount} участников сервера ${guild.name}`);
  }
  await economy.registerCommands();
});

(async () => {
  try {
    // Сначала база данных, потом Discord: модули читают состояние при старте.
    await store.init();
  } catch (error) {
    console.error('❌ Не удалось подключиться к базе данных:', error.message);
    process.exitCode = 1;
    return;
  }

  await client.login(config.TOKEN).catch(error => {
    console.error('❌ Не удалось войти в Discord:', error.message);
    process.exitCode = 1;
  });
})();
