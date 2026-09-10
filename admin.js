const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');
const settings = require('./settings');

let client;
let config;
let db;
let economy;
let debugMode = false;
const startedAt = Date.now();

function embed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description || '').setTimestamp();
}

function isAdmin(member) {
  return Boolean(
    member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
    member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    (config?.ADMIN_ROLE_ID && member?.roles?.cache?.has(config.ADMIN_ROLE_ID)) ||
    (config?.ECONOMY_ADMIN_ROLE_ID && member?.roles?.cache?.has(config.ECONOMY_ADMIN_ROLE_ID)),
  );
}

function isModerator(member) {
  return Boolean(
    isAdmin(member) ||
    member?.permissions?.has(PermissionsBitField.Flags.ManageMessages) ||
    config?.ROLE?.MOD?.some(id => member?.roles?.cache?.has(id)),
  );
}

function isDeveloper(member, userId) {
  return settings.isDeveloper(member, userId, config);
}

function number(value) {
  const parsed = Number(String(value || '').replace(/[ ,]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

async function target(message) {
  const user = message.mentions.users.first();
  if (user) return { user, member: message.mentions.members.first() };
  const id = message.content.match(/\b\d{15,22}\b/)?.[0];
  if (!id) return null;
  const member = await message.guild.members.fetch(id).catch(() => null);
  const fetched = member?.user || await client.users.fetch(id).catch(() => null);
  return fetched ? { user: fetched, member } : null;
}

function cleanTargetArgs(args) {
  return args.filter(item => !/^<@!?\d+>$/.test(item) && !/^\d{15,22}$/.test(item));
}

function logChannel(guild, type) {
  const id = settings.get().logs[type];
  return id ? guild.channels.cache.get(id) : null;
}

async function sendConfiguredLog(guild, type, payload) {
  const channel = logChannel(guild, type);
  if (channel) await channel.send(payload).catch(() => {});
}

async function handle(message) {
  if (!message.guild || message.author.bot) return;
  const body = config.stripPrefix(message.content);
  if (body === null) return;
  const args = body.trim().split(/\s+/);
  const command = (args.shift() || '').toLowerCase();
  if (!['view-case', 'remove-case', 'punishments', 'reason', 'deleted-message-log', 'edited-message-log', 'lock-down', 'slow-mode',
    'add-money', 'remove-money', 'add-money-role', 'remove-money-role', 'set-income', 'reset-money', 'reset-economy', 'set-currency',
    'set-start-balance', 'maximum-balance', 'economy-stats', 'money-audit-log', 'clean-leaderboard', 'enable', 'disable',
    'permissions', 'channel-override', 'command-status', 'bot-info', 'reload', 'maintenance', 'logs', 'debug', 'config',
    'database-stats', 'backup', 'permissions-admin'].includes(command)) return;

  if (!settings.isAllowed(message, command, config) && !isDeveloper(message.member, message.author.id)) {
    return message.reply('⛔ Эта команда запрещена для тебя в текущем канале.');
  }

  if (['view-case', 'remove-case', 'punishments', 'deleted-message-log', 'edited-message-log', 'lock-down', 'slow-mode'].includes(command)) {
    if (!isModerator(message.member)) return message.reply('❌ Нужны права модератора.');
  } else if (['bot-info', 'reload', 'maintenance', 'logs', 'debug', 'config', 'database-stats', 'backup', 'permissions-admin'].includes(command)) {
    if (!isDeveloper(message.member, message.author.id)) return message.reply('❌ Только разработчики.');
  } else if (!isAdmin(message.member)) {
    return message.reply('❌ Нужны права администратора.');
  }

  if (command === 'view-case') {
    const item = db.findPunishment(args[0]);
    if (!item || item.guild_id !== message.guild.id) return message.reply('❌ Кейс не найден.');
    return message.channel.send({ embeds: [embed(0x5865f2, `📋 Кейс #${item.id}`, `Тип: **${item.type || 'наказание'}**\nПользователь: <@${item.user_id}>\nПричина: **${item.reason || 'Без причины'}**\nСоздан: <t:${Math.floor((item.timestamp || Date.now()) / 1000)}:F>`)] });
  }

  if (command === 'remove-case') {
    const item = db.findPunishment(args[0]);
    if (!item || item.guild_id !== message.guild.id || !db.removeCase(args[0])) return message.reply('❌ Кейс не найден.');
    return message.reply(`✅ Кейс **#${args[0]}** удалён.`);
  }

  if (command === 'punishments') {
    const t = await target(message);
    if (!t) return message.reply('❌ Укажи пользователя.');
    const rows = db.getPunishmentsByUser(message.guild.id, t.user.id);
    const text = rows.length
      ? rows.slice(0, 20).map(item => `**#${item.id}** ${item.type} — ${item.reason || 'Без причины'}`).join('\n')
      : 'История наказаний пуста.';
    return message.channel.send({ embeds: [embed(0xfee75c, `📚 История наказаний ${t.user.tag}`, text)] });
  }

  if (command === 'reason') {
    const id = Number(args.shift());
    const reason = args.join(' ');
    const item = db.findPunishment(id);
    if (!item || item.guild_id !== message.guild.id || !reason || !db.updateCaseReason(id, reason)) return message.reply('❌ Формат: `!reason <номер> <причина>`');
    return message.reply(`✅ Причина кейса **#${id}** обновлена.`);
  }

  if (command === 'lock-down') {
    const enabled = !['off', 'disable', '0', 'нет'].includes((args[0] || '').toLowerCase());
    const everyone = message.guild.roles.everyone;
    await message.channel.permissionOverwrites.edit(everyone, { SendMessages: !enabled }).catch(() => {});
    return message.reply(enabled ? '🔒 Канал закрыт для обычных участников.' : '🔓 Канал снова открыт.');
  }

  if (command === 'slow-mode') {
    const seconds = Math.max(0, Math.min(21600, Number(args[0]) || 0));
    if (!message.channel.setRateLimitPerUser) return message.reply('❌ Этот канал не поддерживает slow-mode.');
    await message.channel.setRateLimitPerUser(seconds).catch(() => {});
    return message.reply(seconds ? `🐢 Медленный режим установлен: **${seconds} сек.**` : '✅ Медленный режим отключён.');
  }

  if (command === 'deleted-message-log' || command === 'edited-message-log') {
    const channel = message.mentions.channels.first() || message.channel;
    const type = command === 'deleted-message-log' ? 'deleted' : 'edited';
    settings.setLog(type, channel.id);
    return message.reply(`✅ Лог ${type === 'deleted' ? 'удалённых' : 'изменённых'} сообщений: <#${channel.id}>.`);
  }

  if (command === 'add-money' || command === 'remove-money') {
    const t = await target(message);
    const amount = number(args.find(value => /^\d[\d, ]*$/.test(value)));
    if (!t || !amount) return message.reply(`❌ Формат: \`!${command} @user <сумма>\``);
    const ok = command === 'add-money'
      ? economy.addMoney(t.user.id, amount, message.author.id)
      : economy.removeMoney(t.user.id, amount, message.author.id);
    return message.reply(ok ? `✅ Операция выполнена для <@${t.user.id}>: **${economy.money(amount)}**.` : '❌ Недостаточно денег или превышен лимит.');
  }

  if (command === 'set-income') {
    const t = await target(message);
    const amount = number(args.find(value => /^\d[\d, ]*$/.test(value)));
    const intervalText = args.find(value => /^\d+(m|h|d)$/i.test(value));
    const intervalMatch = intervalText?.match(/^(\d+)(m|h|d)$/i);
    if (!t || !amount || !intervalMatch) return message.reply('❌ Формат: `!set-income @user <сумма> <интервал: 1h/1d> [название]`');
    const units = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    const intervalMs = Number(intervalMatch[1]) * units[intervalMatch[2].toLowerCase()];
    const name = cleanTargetArgs(args).filter(value => value !== String(amount) && value !== intervalText).join(' ') || 'Источник дохода';
    economy.setIncome(t.user.id, amount, intervalMs, name);
    return message.reply(`✅ <@${t.user.id}> назначен источник **${name}**: **${economy.money(amount)}** каждые **${intervalText}**.`);
  }

  if (command === 'add-money-role' || command === 'remove-money-role') {
    const role = message.mentions.roles.first();
    const amount = number(args.find(value => /^\d[\d, ]*$/.test(value)));
    if (!role || !amount) return message.reply(`❌ Формат: \`!${command} @role <сумма>\``);
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const member of members.values()) {
      if (!member.roles.cache.has(role.id)) continue;
      const ok = command === 'add-money-role'
        ? economy.addMoney(member.id, amount, message.author.id)
        : economy.removeMoney(member.id, amount, message.author.id);
      if (ok) count++;
    }
    return message.reply(`✅ Операция выполнена для **${count}** участников роли.`);
  }

  if (command === 'reset-money') {
    const t = await target(message);
    if (!t) return message.reply('❌ Укажи пользователя.');
    economy.resetUser(t.user.id);
    return message.reply(`✅ Баланс <@${t.user.id}> сброшен.`);
  }
  if (command === 'reset-economy') {
    economy.resetEconomy();
    return message.reply('⚠️ Экономика сервера сброшена.');
  }
  if (command === 'set-currency') {
    economy.setCurrency(args.join(' '));
    return message.reply(`✅ Символ валюты изменён на **${args.join(' ')}**.`);
  }
  if (command === 'set-start-balance') {
    const amount = number(args[0]);
    if (!amount) return message.reply('❌ Укажи положительную сумму.');
    config.ECONOMY_STARTING_BALANCE = amount;
    return message.reply(`✅ Стартовый баланс новых участников: **${economy.money(amount)}**. Сохрани это значение в переменных окружения.`);
  }
  if (command === 'maximum-balance') {
    const account = args[0] === 'bank' ? 'ECONOMY_MAX_BANK' : 'ECONOMY_MAX_CASH';
    const amount = number(args[1]) || 0;
    config[account] = amount;
    return message.reply(`✅ Максимум ${account.endsWith('BANK') ? 'банка' : 'наличных'}: **${amount || 'без лимита'}**.`);
  }
  if (command === 'economy-stats') {
    const stats = economy.stats();
    return message.channel.send({ embeds: [embed(0x5865f2, '📊 Статистика экономики', `Участников: **${stats.users}**\nВ наличных: **${economy.money(stats.cash)}**\nВ банке: **${economy.money(stats.bank)}**\nТоваров: **${stats.products}**\nОпераций: **${stats.transactions}**`)] });
  }
  if (command === 'money-audit-log') {
    const channel = message.mentions.channels.first() || message.channel;
    settings.setLog('money', channel.id);
    return message.reply(`✅ Журнал денежных операций: <#${channel.id}>.`);
  }
  if (command === 'clean-leaderboard') {
    const members = await message.guild.members.fetch();
    const allUsers = economy.exportData();
    const parsed = JSON.parse(allUsers);
    for (const id of Object.keys(parsed.users || {})) {
      if (!members.has(id)) delete parsed.users[id];
    }
    fs.writeFileSync(path.join(__dirname, 'economy.json'), JSON.stringify(parsed, null, 2));
    return message.reply('✅ Из рейтинга удалены ушедшие участники.');
  }

  if (command === 'enable' || command === 'disable') {
    settings.setGlobalCommand(args[0], command === 'enable');
    return message.reply(`✅ Команда **${args[0]}** ${command === 'enable' ? 'включена' : 'выключена'}.`);
  }
  if (command === 'permissions') {
    const role = message.mentions.roles.first();
    const user = message.mentions.users.first();
    const action = args.find(value => ['allow', 'deny', 'delete', 'clear', 'list'].includes(value.toLowerCase()))?.toLowerCase();
    const commandName = args[args.length - 1];
    const subject = role || user;
    const collection = role ? settings.get().rolePermissions : settings.get().userPermissions;
    if (!subject || !action) return message.reply('❌ Формат: `!permissions allow @role/@user <команда>`');
    if (action === 'list') {
      const permissions = collection[subject.id] || { allow: [], deny: [] };
      return message.reply(`Права ${role ? `роли **${role.name}**` : `пользователя <@${user.id}>`}:\nРазрешены: ${permissions.allow.join(', ') || 'нет'}\nЗапрещены: ${permissions.deny.join(', ') || 'нет'}`);
    }
    if (action === 'clear') settings.clearPermission(collection, subject.id);
    else if (action === 'delete') {
      settings.removePermission(collection, subject.id, 'allow', commandName);
      settings.removePermission(collection, subject.id, 'deny', commandName);
    } else settings.addPermission(collection, subject.id, action, commandName);
    return message.reply(`✅ Права ${role ? 'роли' : 'пользователя'} обновлены.`);
  }
  if (command === 'channel-override') {
    const action = args.shift()?.toLowerCase();
    const commandName = args.join(' ');
    if (!['allow', 'deny'].includes(action) || !commandName) return message.reply('❌ Формат: `!channel-override allow <команда>`');
    settings.setChannelOverride(message.channel.id, commandName, action);
    return message.reply(`✅ Команда **${commandName}** ${action === 'allow' ? 'разрешена' : 'запрещена'} в этом канале.`);
  }
  if (command === 'command-status') {
    const channel = message.mentions.channels.first() || message.channel;
    const current = settings.get().channelOverrides[channel.id] || { allow: [], deny: [] };
    return message.reply(`Состояние команд в <#${channel.id}>:\nРазрешены: ${current.allow.join(', ') || 'нет'}\nЗапрещены: ${current.deny.join(', ') || 'нет'}`);
  }

  if (command === 'bot-info') {
    return message.channel.send({ embeds: [embed(0x5865f2, '🤖 Информация о боте', `Версия: **${require('./package.json').version}**\nUptime: **${Math.floor((Date.now() - startedAt) / 1000)} сек.**\nСерверов: **${client.guilds.cache.size}**\nПользователей: **${client.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0)}**`)] });
  }
  if (command === 'reload') {
    settings.load();
    return message.reply('✅ Конфигурация перезагружена.');
  }
  if (command === 'maintenance') {
    const enabled = !['off', '0', 'disable'].includes((args[0] || '').toLowerCase());
    settings.setMaintenance(enabled);
    return message.reply(enabled ? '🛠️ Режим технических работ включён.' : '✅ Режим технических работ выключен.');
  }
  if (command === 'logs') {
    const current = settings.get().logs;
    return message.reply(`Логи:\nУдаления: ${current.deleted ? `<#${current.deleted}>` : 'не настроены'}\nРедактирования: ${current.edited ? `<#${current.edited}>` : 'не настроены'}\nДеньги: ${current.money ? `<#${current.money}>` : 'не настроены'}`);
  }
  if (command === 'debug') {
    debugMode = !['off', '0', 'disable'].includes((args[0] || '').toLowerCase());
    return message.reply(`🐞 Диагностический режим ${debugMode ? 'включён' : 'выключен'}.`);
  }
  if (command === 'config') {
    const safe = Object.keys(config).filter(key => !['TOKEN', 'PANEL_PASSWORD'].includes(key)).map(key => `${key}: ${typeof config[key] === 'object' ? '[object]' : config[key] || 'не задано'}`).join('\n');
    return message.reply(`\`\`\`\n${safe.slice(0, 1900)}\n\`\`\``);
  }
  if (command === 'database-stats') {
    const dbData = db.getAllData();
    return message.reply(`🗄️ База: варнов **${dbData.warns.length}**, наказаний **${dbData.punishments.length}**, выговоров **${dbData.reprimands.length}**, ивентов **${dbData.events.length}**.`);
  }
  if (command === 'backup') {
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const file = path.join(backupDir, `backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ moderation: db.getAllData(), economy: JSON.parse(economy.exportData()), settings: settings.get() }, null, 2));
    return message.reply(`✅ Резервная копия создана: **${path.basename(file)}**.`);
  }
  if (command === 'permissions-admin') {
    return message.reply(`⚙️ Полный доступ администратора активен. Пользователей с отдельными правами: **${Object.keys(settings.get().userPermissions).length}**, ролей: **${Object.keys(settings.get().rolePermissions).length}**.`);
  }
}

function init(discordClient, botConfig, database, economyModule) {
  client = discordClient;
  config = botConfig;
  db = database;
  economy = economyModule;
  settings.load();
  client.on('messageCreate', message => handle(message).catch(error => console.error('Ошибка admin-команд:', error)));
  client.on('messageDelete', message => {
    if (!message.guild || !message.author || !settings.get().logs.deleted) return;
    sendConfiguredLog(message.guild, 'deleted', { embeds: [embed(0xed4245, '🗑️ Сообщение удалено', `Автор: **${message.author.tag}**\nКанал: <#${message.channel.id}>\n${message.content ? `Текст: ${message.content.slice(0, 1000)}` : 'Текст недоступен'}`)] });
  });
  client.on('messageUpdate', (oldMessage, newMessage) => {
    if (!newMessage.guild || !newMessage.author || !settings.get().logs.edited || oldMessage.content === newMessage.content) return;
    sendConfiguredLog(newMessage.guild, 'edited', { embeds: [embed(0xffc857, '✏️ Сообщение изменено', `Автор: **${newMessage.author.tag}**\nКанал: <#${newMessage.channel.id}>\nБыло: ${oldMessage.content?.slice(0, 700) || '—'}\nСтало: ${newMessage.content?.slice(0, 700) || '—'}`)] });
  });
  console.log('✅ Административные команды загружены');
}

module.exports = { init };