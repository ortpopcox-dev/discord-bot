const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
} = require('discord.js');
const settings = require('./settings');

const store = require('./store');

const KEY = 'economy';
const MAX_TEXT = 900;
const GAME_TIMEOUT = 2 * 60 * 1000;

let _client = null;
let _config = null;
let data = {
  users: {},
  products: {},
  nextProductId: 1,
  currency: null,
  reputation: {},
  economyLog: [],
};
const games = new Map();
const challenges = new Map();

function load() {
  const loaded = store.read(KEY, null);
  if (loaded && typeof loaded === 'object') data = loaded;
  if (!data || typeof data !== 'object') data = {};
  if (!data.users || typeof data.users !== 'object') data.users = {};
  if (!data.products || typeof data.products !== 'object') data.products = {};
  if (!Number.isInteger(data.nextProductId)) data.nextProductId = 1;
  if (!data.reputation || typeof data.reputation !== 'object') data.reputation = {};
  if (!Array.isArray(data.economyLog)) data.economyLog = [];
  if (!data.workRoles || typeof data.workRoles !== 'object') data.workRoles = {};
  save();
}

function save() {
  store.write(KEY, data);
}

// Заменить весь набор данных экономики (используется админ-командами).
function importData(next) {
  if (!next || typeof next !== 'object') return false;
  data = next;
  load();
  return true;
}

function getUser(userId) {
  if (!data.users[userId]) {
    data.users[userId] = {
      balance: Number(_config?.ECONOMY_STARTING_BALANCE) || 1000,
      cash: Number(_config?.ECONOMY_STARTING_BALANCE) || 1000,
      bank: Number(_config?.ECONOMY_STARTING_BANK) || 0,
      workAt: 0,
      dailyAt: 0,
      weeklyAt: 0,
      xp: 0,
      inventory: [],
      incomeSource: null,
    };
    save();
  }
  const user = data.users[userId];
  if (!Number.isFinite(user.cash)) user.cash = Number.isFinite(user.balance) ? user.balance : 0;
  if (!Number.isFinite(user.bank)) user.bank = 0;
  if (!Number.isFinite(user.xp)) user.xp = 0;
  if (!Number.isFinite(user.weeklyAt)) user.weeklyAt = 0;
  if (user.balance !== user.cash) user.balance = user.cash;
  if (!Array.isArray(user.inventory)) user.inventory = [];
  if (!user.collectAt || typeof user.collectAt !== 'object') user.collectAt = {};
  return user;
}

function money(value) {
  const currency = data.currency || _config?.ECONOMY_CURRENCY || 'монет';
  return `${Math.floor(value).toLocaleString('ru-RU')} ${currency}`;
}

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function token() {
  return crypto.randomBytes(5).toString('hex');
}

function parseBet(value) {
  const bet = Number.parseInt(value, 10);
  const max = Number(_config?.ECONOMY_MAX_BET) || 1_000_000;
  return Number.isInteger(bet) && bet > 0 && bet <= max ? bet : null;
}

function debit(userId, amount) {
  const user = getUser(userId);
  if (user.cash < amount) return false;
  user.cash -= amount;
  user.balance = user.cash;
  logMoney('debit', userId, amount, 'cash');
  save();
  return true;
}

function credit(userId, amount) {
  if (!amount || amount < 0) return;
  const user = getUser(userId);
  user.cash += Math.floor(amount);
  user.balance = user.cash;
  logMoney('credit', userId, amount, 'cash');
  save();
}

function balance(userId) {
  return getUser(userId).cash;
}

/** Чтение баланса без создания записи пользователя (для ИИ/панели). */
function peek(userId) {
  const user = data.users[userId];
  return user && Number.isFinite(user.cash) ? user.cash : null;
}

function logMoney(type, userId, amount, account, actorId = null) {
  data.economyLog.push({ type, userId, amount: Math.floor(amount), account, actorId, timestamp: Date.now() });
  if (data.economyLog.length > 5000) data.economyLog.splice(0, data.economyLog.length - 5000);
}

function totalBalance(userId) {
  const user = getUser(userId);
  return user.cash + user.bank;
}

function addCash(userId, amount, actorId = null) {
  const user = getUser(userId);
  const max = Number(_config?.ECONOMY_MAX_CASH) || 0;
  const value = Math.max(0, Math.floor(amount));
  if (max && user.cash + value > max) return false;
  user.cash += value;
  user.balance = user.cash;
  user.xp += Math.max(1, Math.floor(value / 100));
  logMoney('credit', userId, value, 'cash', actorId);
  save();
  return true;
}

function removeCash(userId, amount, actorId = null) {
  const user = getUser(userId);
  const value = Math.max(0, Math.floor(amount));
  if (user.cash < value) return false;
  user.cash -= value;
  user.balance = user.cash;
  logMoney('debit', userId, value, 'cash', actorId);
  save();
  return true;
}

function deposit(userId, requested) {
  const user = getUser(userId);
  const amount = requested === 'all' ? user.cash : parseNumber(requested);
  if (!amount || amount > user.cash) return null;
  const max = Number(_config?.ECONOMY_MAX_BANK) || 0;
  if (max && user.bank + amount > max) return null;
  user.cash -= amount;
  user.bank += amount;
  user.balance = user.cash;
  logMoney('deposit', userId, amount, 'bank');
  save();
  return amount;
}

function withdraw(userId, requested) {
  const user = getUser(userId);
  const amount = requested === 'all' ? user.bank : parseNumber(requested);
  if (!amount || amount > user.bank) return null;
  const max = Number(_config?.ECONOMY_MAX_CASH) || 0;
  if (max && user.cash + amount > max) return null;
  user.bank -= amount;
  user.cash += amount;
  user.balance = user.cash;
  logMoney('withdraw', userId, amount, 'bank');
  save();
  return amount;
}

function setCurrency(value) {
  data.currency = String(value || '').trim().slice(0, 12) || (_config?.ECONOMY_CURRENCY || 'монет');
  save();
}

function addMoney(userId, amount, actorId) {
  return addCash(userId, amount, actorId);
}

function removeMoney(userId, amount, actorId) {
  return removeCash(userId, amount, actorId);
}

function resetUser(userId) {
  data.users[userId] = {
    balance: Number(_config?.ECONOMY_STARTING_BALANCE) || 1000,
    cash: Number(_config?.ECONOMY_STARTING_BALANCE) || 1000,
    bank: Number(_config?.ECONOMY_STARTING_BANK) || 0,
    workAt: 0, dailyAt: 0, weeklyAt: 0, xp: 0, inventory: [], incomeSource: null,
  };
  save();
}

function resetEconomy() {
  data.users = {};
  data.reputation = {};
  data.economyLog = [];
  save();
}

function parseNumber(value) {
  const number = Number(String(value || '').replace(/[, ]/g, ''));
  return Number.isFinite(number) && number > 0 && number <= 1_000_000_000 ? Math.floor(number) : null;
}

function baseEmbed(color, title, description) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (description) embed.setDescription(description.slice(0, 4096));
  return embed;
}

function button(customId, label, style) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function row(...buttons) {
  return new ActionRowBuilder().addComponents(buttons);
}

function gameButtons(type, id) {
  if (type === 'bj') {
    return row(
      button(`eco:bj:hit:${id}`, 'Взять карту', ButtonStyle.Primary),
      button(`eco:bj:stand:${id}`, 'Остановиться', ButtonStyle.Secondary),
    );
  }
  if (type === 'cf') {
    return row(
      button(`eco:cf:heads:${id}`, 'Орёл', ButtonStyle.Primary),
      button(`eco:cf:tails:${id}`, 'Решка', ButtonStyle.Secondary),
    );
  }
  if (type === 'roulette') {
    return row(
      button(`eco:roulette:red:${id}`, 'Красное', ButtonStyle.Danger),
      button(`eco:roulette:black:${id}`, 'Чёрное', ButtonStyle.Secondary),
      button(`eco:roulette:green:${id}`, 'Зелёное 0', ButtonStyle.Success),
    );
  }
  if (type === 'rps') {
    return row(
      button(`eco:rps:rock:${id}`, 'Камень', ButtonStyle.Secondary),
      button(`eco:rps:paper:${id}`, 'Бумага', ButtonStyle.Primary),
      button(`eco:rps:scissors:${id}`, 'Ножницы', ButtonStyle.Danger),
    );
  }
  return null;
}

function holdGame(userId, amount, game) {
  if (!debit(userId, amount)) return null;
  const id = token();
  game.id = id;
  game.timer = setTimeout(() => {
    const pending = games.get(id);
    if (!pending) return;
    games.delete(id);
    credit(pending.userId, pending.bet);
    pending.message.edit({
      content: `⌛ Игра отменена по тайм-ауту. Ставка ${money(pending.bet)} возвращена.`,
      components: [],
    }).catch(() => {});
  }, GAME_TIMEOUT);
  games.set(id, game);
  return id;
}

function finishGame(id, payout, content, message, { reply = false, balanceOf = null } = {}) {
  const game = games.get(id);
  if (!game) return;
  clearTimeout(game.timer);
  games.delete(id);
  if (payout > 0) credit(game.userId, payout);
  if (balanceOf) content += `\nБаланс: **${money(balance(balanceOf))}**`;
  // Сообщение автора редактировать нельзя — тогда отвечаем новым сообщением.
  if (reply) {
    (message.reply ? message.reply({ content }) : message.channel.send({ content })).catch(() => {});
    return;
  }
  message.edit({ content, components: [] }).catch(() => {});
}

function validateBetMessage(message, args) {
  const bet = parseBet(args[0]);
  if (!bet) {
    message.reply(`❌ Укажи ставку от 1 до ${money(Number(_config?.ECONOMY_MAX_BET) || 1_000_000)}: \`!${args.command || 'game'} 500\``);
    return null;
  }
  if (balance(message.author.id) < bet) {
    message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
    return null;
  }
  return bet;
}

function rob(message) {
  const target = message.mentions.users.first();
  if (!target) return message.reply('❌ Формат: `!rob @юзер`');
  if (target.bot || target.id === message.author.id) return message.reply('❌ Нельзя ограбить самого себя или бота.');
  const thief = getUser(message.author.id);
  const cooldown = 60 * 60 * 1000;
  const left = (thief.robAt || 0) + cooldown - Date.now();
  if (left > 0) return message.reply(`⏳ Грабить снова можно через **${formatLeft(left)}**.`);
  const victim = getUser(target.id);
  const amount = Math.floor(victim.cash * 0.25);
  if (amount < 1) return message.reply(`❌ У <@${target.id}> нет наличных для грабежа.`);
  thief.robAt = Date.now();
  if (!removeCash(target.id, amount, message.author.id)) return message.reply('❌ Не удалось ограбить: у жертвы изменился баланс.');
  addCash(message.author.id, amount, message.author.id);
  save();
  return message.reply({ embeds: [baseEmbed(0xed4245, '🕵️ Успешный грабёж', `Ты украл у <@${target.id}> 25% наличных — **${money(amount)}**.\nТвои наличные: **${money(getUser(message.author.id).cash)}**`)] });
}

function pay(message, args) {
  const target = message.mentions.users.first();
  if (!target) return message.reply('❌ Формат: `!pay @юзер сумма`');
  if (target.bot || target.id === message.author.id) return message.reply('❌ Нельзя перевести деньги себе или боту.');
  const amount = parseNumber(args.find(value => /^\d[\d, ]*$/.test(value)));
  if (!amount) return message.reply('❌ Укажи корректную сумму. Пример: `!pay @юзер 500`');
  if (!removeCash(message.author.id, amount, message.author.id)) {
    return message.reply(`❌ Недостаточно наличных. У тебя: **${money(getUser(message.author.id).cash)}**`);
  }
  if (!addCash(target.id, amount, message.author.id)) {
    addCash(message.author.id, amount, message.author.id);
    return message.reply('❌ Перевод отменён: у получателя превышен лимит баланса.');
  }
  return message.reply({ embeds: [baseEmbed(0x57f287, '💸 Перевод выполнен', `Ты передал <@${target.id}> **${money(amount)}**.\nТвои наличные: **${money(getUser(message.author.id).cash)}**`)] });
}


function work(message) {
  const user = getUser(message.author.id);
  const cooldown = 60 * 60 * 1000;
  const left = user.workAt + cooldown - Date.now();
  if (left > 0) return message.reply(`⏳ Работать снова можно через **${formatLeft(left)}**.`);
  const reward = randomInt(Number(_config?.ECONOMY_WORK_MIN) || 100, Number(_config?.ECONOMY_WORK_MAX) || 300);
  user.workAt = Date.now();
  addCash(message.author.id, reward);
  return message.reply({ embeds: [baseEmbed(0x57f287, '💼 Работа выполнена', `Ты заработал **${money(reward)}**.\nНаличные: **${money(user.cash)}**`)] });
}

function daily(message) {
  const user = getUser(message.author.id);
  const cooldown = 24 * 60 * 60 * 1000;
  const left = user.dailyAt + cooldown - Date.now();
  if (left > 0) return message.reply(`🎁 Награду можно получить снова через **${formatLeft(left)}**.`);
  const reward = randomInt(Number(_config?.ECONOMY_DAILY_MIN) || 500, Number(_config?.ECONOMY_DAILY_MAX) || 1000);
  user.dailyAt = Date.now();
  addCash(message.author.id, reward);
  return message.reply({ embeds: [baseEmbed(0xffc857, '🎁 Ежедневная награда', `Ты получил **${money(reward)}**.\nНаличные: **${money(user.cash)}**`)] });
}

function weekly(message) {
  const user = getUser(message.author.id);
  const cooldown = 7 * 24 * 60 * 60 * 1000;
  const left = user.weeklyAt + cooldown - Date.now();
  if (left > 0) return message.reply(`🎁 Еженедельную награду можно получить через **${formatLeft(left)}**.`);
  const reward = randomInt(Number(_config?.ECONOMY_WEEKLY_MIN) || 1500, Number(_config?.ECONOMY_WEEKLY_MAX) || 3000);
  user.weeklyAt = Date.now();
  addCash(message.author.id, reward);
  return message.reply({ embeds: [baseEmbed(0x9b59b6, '🎁 Еженедельная награда', `Ты получил **${money(reward)}**.\nНаличные: **${money(user.cash)}**`)] });
}

function collectIncome(message) {
  const user = getUser(message.author.id);
  const source = user.incomeSource;
  if (!source || !source.amount || !source.intervalMs) {
    return message.reply('❌ У тебя нет назначенного источника дохода.');
  }
  const now = Date.now();
  const last = Number(source.lastCollected || source.assignedAt || now);
  const units = Math.floor((now - last) / source.intervalMs);
  if (units < 1) return message.reply(`⏳ Доход будет доступен через **${formatLeft(source.intervalMs - (now - last))}**.`);
  const amount = units * Math.floor(source.amount);
  source.lastCollected = last + units * source.intervalMs;
  addCash(message.author.id, amount);
  save();
  return message.reply({ embeds: [baseEmbed(0x57f287, '💼 Доход получен', `Начислено **${money(amount)}** от источника **${source.name || 'доход'}**.\nНаличные: **${money(user.cash)}**`)] });
}

function setIncome(userId, amount, intervalMs, name = 'Источник дохода') {
  const user = getUser(userId);
  user.incomeSource = { name: String(name).slice(0, 60), amount: Math.floor(amount), intervalMs, assignedAt: Date.now(), lastCollected: Date.now() };
  save();
}


// ─── Рабочие роли (/clwork + !collect) ───────────────────────────────────────

function parseCooldown(value) {
  const match = String(value || '').trim().match(/^(\d+)\s*(с|м|ч|д|s|m|h|d)$/i);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const map = { 'с': 1000, 's': 1000, 'м': 60000, 'm': 60000, 'ч': 3600000, 'h': 3600000, 'д': 86400000, 'd': 86400000 };
  const ms = amount * (map[unit] || 0);
  return ms > 0 ? ms : null;
}

function roleIdFromArg(guild, raw) {
  if (!raw) return null;
  const mention = String(raw).match(/^<@&(\d+)>$/);
  if (mention) return mention[1];
  return normalizeRoleId(guild, raw);
}

function setWorkRole(roleId, amount, cooldownMs) {
  data.workRoles[roleId] = { roleId, amount: Math.floor(amount), cooldownMs, updatedAt: Date.now() };
  save();
  return data.workRoles[roleId];
}

function removeWorkRole(roleId) {
  if (!data.workRoles[roleId]) return false;
  delete data.workRoles[roleId];
  save();
  return true;
}

function workRoles() {
  return Object.values(data.workRoles || {});
}

function collectWork(message) {
  const member = message.member;
  const roles = workRoles().filter(item => member?.roles?.cache?.has(item.roleId));
  if (!roles.length) {
    return message.reply('❌ У тебя нет ролей, которые приносят деньги. Их выдаёт администрация через `/clwork`.');
  }
  const user = getUser(message.author.id);
  const now = Date.now();
  const paid = [];
  const waiting = [];
  let total = 0;
  for (const item of roles) {
    const last = Number(user.collectAt[item.roleId] || 0);
    if (now - last < item.cooldownMs) {
      waiting.push(`<@&${item.roleId}> — через **${formatLeft(item.cooldownMs - (now - last))}**`);
      continue;
    }
    user.collectAt[item.roleId] = now;
    total += Math.floor(item.amount);
    paid.push(`<@&${item.roleId}> — **${money(item.amount)}**`);
  }
  if (!total) {
    save();
    return message.reply({ embeds: [baseEmbed(0xffc857, '⏳ Пока рано', waiting.join('\n'))] });
  }
  addCash(message.author.id, total);
  save();
  const lines = [paid.join('\n'), `\nИтого: **${money(total)}**\nНаличные: **${money(getUser(message.author.id).cash)}**`];
  if (waiting.length) lines.push(`\nЕщё на кулдауне:\n${waiting.join('\n')}`);
  return message.reply({ embeds: [baseEmbed(0x57f287, '💼 Зарплата получена', lines.join('\n'))] });
}

async function clwork(message, args) {
  if (!canManageEconomy(message.member) && !settings.isDeveloper(message.member, message.author.id, _config)) {
    return message.reply('❌ Настраивать рабочие роли могут только администраторы.');
  }
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'list' || sub === 'список') {
    const list = workRoles();
    if (!list.length) return message.reply('📭 Рабочих ролей пока нет.');
    return message.reply({
      embeds: [baseEmbed(0x5865f2, '💼 Рабочие роли',
        list.map(item => `<@&${item.roleId}> — **${money(item.amount)}** раз в **${formatLeft(item.cooldownMs)}**`).join('\n'))],
    });
  }
  if (sub === 'remove' || sub === 'delete' || sub === 'удалить') {
    const roleId = roleIdFromArg(message.guild, args[1]);
    if (!roleId) return message.reply('❌ Укажи роль: `!clwork remove @роль`');
    return message.reply(removeWorkRole(roleId)
      ? `✅ Роль <@&${roleId}> больше не приносит деньги.`
      : '❌ Эта роль не была рабочей.');
  }
  const roleId = roleIdFromArg(message.guild, args[0]);
  const amount = Number.parseInt(args[1], 10);
  const cooldownMs = parseCooldown(args[2]);
  if (!roleId || !Number.isInteger(amount) || amount <= 0 || !cooldownMs) {
    return message.reply('❌ Формат: `/clwork @роль <сумма> <кд>`\nНапример: `/clwork @Работяга 500 30m`\nТакже: `/clwork list`, `/clwork remove @роль`');
  }
  if (!message.guild.roles.cache.has(roleId)) return message.reply('❌ Роль не найдена на сервере.');
  setWorkRole(roleId, amount, cooldownMs);
  return message.reply(`✅ Роль <@&${roleId}> теперь приносит **${money(amount)}** раз в **${formatLeft(cooldownMs)}**. Собрать: \`!collect\``);
}

function reputation(userId) {
  return Number(data.reputation?.[userId]?.count || 0);
}

function addReputation(fromId, toId) {
  if (!data.reputation || typeof data.reputation !== 'object') data.reputation = {};
  const entry = data.reputation[toId] || (data.reputation[toId] = { count: 0, givers: [] });
  if (!Array.isArray(entry.givers)) entry.givers = [];
  if (entry.givers.includes(fromId)) return false;
  entry.givers.push(fromId);
  entry.count = Number(entry.count || 0) + 1;
  save();
  return true;
}

function userRank(userId) {
  const user = getUser(userId);
  return Math.floor(Math.sqrt(Math.max(0, user.xp) / 10)) + 1;
}

function levelProgress(userId) {
  const user = getUser(userId);
  const level = userRank(userId);
  const currentBase = Math.max(0, (level - 1) ** 2 * 10);
  const nextBase = level ** 2 * 10;
  const current = Math.max(0, user.xp - currentBase);
  const needed = Math.max(1, nextBase - currentBase);
  const percent = Math.min(100, Math.floor((current / needed) * 100));
  const filled = Math.round(percent / 10);
  return { level, current, needed, percent, bar: '▰'.repeat(filled) + '▱'.repeat(10 - filled) };
}

const BANNER_PATH = path.join(__dirname, 'assets', 'economy-banner.png');

// Баннер опционален: если файла нет (например, при деплое без папки assets),
// панель отправляется без картинки, а не падает с ENOENT.
function bannerFile() {
  if (!fs.existsSync(BANNER_PATH)) return null;
  return new AttachmentBuilder(BANNER_PATH, { name: 'economy-banner.png' });
}

function panelButtons(active = 'home') {
  const b = (id, label, emoji, style = ButtonStyle.Secondary) =>
    button(`eco:panel:${id}`, `${emoji} ${label}`, style);
  return [
    row(
      b('home', 'Главная', '⌂', active === 'home' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      b('profile', 'Профиль', '👤', active === 'profile' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      b('shop', 'Магазин', '🛒', active === 'shop' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      b('bonus', 'Бонус', '🎁', active === 'bonus' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      b('inventory', 'Инвентарь', '🎒', active === 'inventory' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
    row(
      b('top', 'Топ', '🏆', active === 'top' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      b('refresh', 'Обновить', '🔄', ButtonStyle.Secondary),
    ),
  ];
}

function bannerPayload(embed, active = 'home', extraComponents = []) {
  const banner = bannerFile();
  embed.setFooter({ text: 'Экономика • современная панель' });
  if (banner) embed.setImage('attachment://economy-banner.png');
  return {
    embeds: [embed],
    files: banner ? [banner] : [],
    components: [...panelButtons(active), ...extraComponents],
  };
}

function homeEmbed(guild, user) {
  const progress = levelProgress(user.id);
  const account = getUser(user.id);
  return baseEmbed(0x8b5cf6, `✨ Панель ${guild?.name || 'сервера'}`,
    `Добро пожаловать, **${user.globalName || user.username}**!\n\n` +
    `💰 **Баланс:** ${money(account.cash)}\n` +
    `🏦 **Банк:** ${money(account.bank)}\n` +
    `🏆 **Уровень:** ${progress.level}\n` +
    `⭐ **XP:** ${progress.current} / ${progress.needed}\n` +
    `\`${progress.bar}\` **${progress.percent}%**`)
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
    .addFields(
      { name: '⚡ Быстрые действия', value: '`👤 Профиль`  `🛒 Магазин`  `🎁 Бонус`  `🎒 Инвентарь`', inline: false },
      { name: '💎 Твой статус', value: account.incomeSource ? `Источник дохода: **${account.incomeSource.name}**` : 'Активируй магазин и получай награды', inline: false },
    );
}

function profileEmbed(userId, userObj) {
  const user = getUser(userId);
  const progress = levelProgress(userId);
  const rep = reputation(userId);
  const tag = userObj?.globalName || userObj?.username || `<@${userId}>`;
  const source = user.incomeSource ? `**${user.incomeSource.name}** · ${money(user.incomeSource.amount)} / интервал` : '—';
  const embed = baseEmbed(0x8b5cf6, `👤 Профиль · ${tag}`,
    `**${progress.bar}** ${progress.percent}% до следующего уровня`);
  if (userObj?.displayAvatarURL) embed.setThumbnail(userObj.displayAvatarURL({ extension: 'png', size: 256 }));
  return embed.addFields(
      { name: '💰 Наличные', value: `**${money(user.cash)}**`, inline: true },
      { name: '🏦 Банк', value: `**${money(user.bank)}**`, inline: true },
      { name: '💎 Всего', value: `**${money(user.cash + user.bank)}**`, inline: true },
      { name: '🏆 Уровень', value: `**${progress.level}**`, inline: true },
      { name: '⭐ Опыт', value: `**${user.xp} XP**`, inline: true },
      { name: '🌟 Репутация', value: `**${rep}**`, inline: true },
      { name: '💼 Источник дохода', value: source, inline: false },
    );
}

function leaderboardEmbed(page = 1) {
  const size = 10;
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const users = Object.entries(data.users)
    .map(([id, user]) => ({ id, total: Number(user.cash || user.balance || 0) + Number(user.bank || 0) }))
    .sort((a, b) => b.total - a.total);
  const start = (currentPage - 1) * size;
  const rows = users.slice(start, start + size);
  const lines = rows.length ? rows.map((item, index) => `${['🥇','🥈','🥉'][start + index] || `**${start + index + 1}.**`} <@${item.id}> — **${money(item.total)}**`).join('\n') : 'На этой странице пока нет участников.';
  return baseEmbed(0xf1c40f, `🏆 Топ пользователей · ${currentPage}`, lines)
    .addFields({ name: '📊 Всего участников', value: `${users.length}`, inline: true });
}

function profilePayload(userId, userObj, active = 'profile') {
  return bannerPayload(profileEmbed(userId, userObj), active);
}

async function resolveUser(userId) {
  if (_client?.users?.cache?.has(userId)) return _client.users.cache.get(userId);
  return _client?.users?.fetch(userId).catch(() => null);
}

function profile(message, targetId, tag) {
  return resolveUser(targetId).then(userObj => message.channel.send(profilePayload(targetId, userObj || { username: tag || targetId }, 'profile')));
}

function leaderboard(message, page = 1) {
  return message.channel.send(bannerPayload(leaderboardEmbed(page), 'top'));
}

function stats() {
  const users = Object.values(data.users);
  return {
    users: users.length,
    cash: users.reduce((sum, user) => sum + Number(user.cash || user.balance || 0), 0),
    bank: users.reduce((sum, user) => sum + Number(user.bank || 0), 0),
    products: productList().length,
    transactions: data.economyLog.length,
  };
}

function exportData() {
  return JSON.stringify(data, null, 2);
}

function formatLeft(ms) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.ceil((ms % 3_600_000) / 60_000);
  return hours ? `${hours}ч ${minutes}м` : `${minutes}м`;
}

function productList() {
  return Object.values(data.products).filter(p => p.active !== false);
}

// ─── Продажа ролей ────────────────────────────────────────────────────────────

function isDeveloperMember(member, userId) {
  return settings.isDeveloper(member, userId, _config);
}

// Проверяет, что бот реально сможет выдать роль покупателю.
function checkRoleManageable(guild, roleId) {
  if (!guild) return { ok: false, error: 'Не удалось определить сервер.' };
  const role = guild.roles.cache.get(roleId);
  if (!role) return { ok: false, error: 'Роль не найдена на этом сервере.' };
  if (role.id === guild.id) return { ok: false, error: 'Нельзя продавать роль @everyone.' };
  if (role.managed) return { ok: false, error: 'Эта роль управляется интеграцией (бот/буст) и не может быть выдана.' };
  const me = guild.members.me;
  if (!me) return { ok: false, error: 'Бот не найден на сервере.' };
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { ok: false, error: 'У бота нет права **Управление ролями**.' };
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return { ok: false, error: `Роль **${role.name}** выше или равна высшей роли бота — подними роль бота выше в настройках сервера.` };
  }
  return { ok: true, role };
}

// Приводит любой ввод (ID, <@&ID>, название роли) к настоящему ID роли сервера.
function normalizeRoleId(guild, value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const mention = raw.match(/^<@&(\d+)>$/);
  const id = mention ? mention[1] : (/^\d{5,25}$/.test(raw) ? raw : null);
  if (id) {
    if (!guild) return id;
    return guild.roles.cache.has(id) ? id : null;
  }
  if (!guild) return null;
  const lower = raw.toLowerCase();
  const byName = guild.roles.cache.find(r => r.name.toLowerCase() === lower)
    || guild.roles.cache.find(r => r.name.toLowerCase().includes(lower));
  return byName ? byName.id : null;
}

// Находит товар-роль по ID роли, а также чинит старые записи с кривым roleId.
function findRoleListing(roleId, guild) {
  const listings = productList().filter(p => p.roleId);
  const direct = listings.find(p => String(p.roleId) === String(roleId));
  if (direct) return direct;
  if (!guild) return null;
  const role = guild.roles.cache.get(String(roleId));
  if (!role) return null;
  const broken = listings.find(p => {
    if (guild.roles.cache.has(String(p.roleId))) return false;
    const guess = normalizeRoleId(guild, p.roleId) || normalizeRoleId(guild, p.name);
    return guess === role.id;
  });
  if (broken) { broken.roleId = role.id; save(); return broken; }
  return null;
}

// Пытается починить товар с некорректным roleId (создан через /product-create).
function repairProductRole(product, guild) {
  if (!product?.roleId || !guild) return product;
  if (guild.roles.cache.has(String(product.roleId))) return product;
  const fixed = normalizeRoleId(guild, product.roleId) || normalizeRoleId(guild, product.name);
  if (fixed) { product.roleId = fixed; save(); }
  return product;
}

function roleListingsEmbed(guild) {
  const listings = productList().filter(p => p.roleId);
  if (!listings.length) {
    return baseEmbed(0x8b5cf6, '🎭 Роли в продаже', 'Магазин ролей пока пуст.\n\nРазработчик может добавить роль через `/role-sell`.');
  }
  const lines = listings.slice(0, 25).map(p => {
    repairProductRole(p, guild);
    const role = guild?.roles.cache.get(p.roleId);
    return `### ${role ? `<@&${role.id}>` : p.name}\n💰 **${money(p.price)}** · ${p.description || 'Премиальная роль сервера'}`;
  });
  return baseEmbed(0x8b5cf6, '🎭 Роли в продаже', lines.join('\n\n'));
}

function shopEmbed(guild) {
  const products = productList();
  if (!products.length) return baseEmbed(0x8b5cf6, '🛒 Магазин', 'Пока здесь пусто.\n\nАдминистратор может добавить товар командой `/role-sell`.');
  const lines = products.slice(0, 15).map((p, i) => {
    if (p.roleId) repairProductRole(p, guild);
    const role = p.roleId && guild?.roles.cache.get(p.roleId);
    return `**${i + 1}. ${role ? `<@&${role.id}>` : p.name}**\n> 💰 **${money(p.price)}**\n> ${p.description || 'Уникальный товар для участников сервера.'}`;
  });
  return baseEmbed(0x8b5cf6, '🛒 Магазин ролей', 'Выбери товар кнопкой ниже. После покупки роль будет выдана автоматически.\n\n' + lines.join('\n\n'))
    .setFooter({ text: `Товаров в магазине: ${products.length}` });
}

function shopComponents() {
  const products = productList().slice(0, 15);
  const rows = [];
  for (let index = 0; index < products.length; index += 5) {
    rows.push(row(...products.slice(index, index + 5).map(product =>
      button(`eco:buy:${product.id}`, `Купить #${product.id}`, ButtonStyle.Success),
    )));
  }
  return rows;
}

function inventoryEmbed(userId, userTag) {
  const inventory = getUser(userId).inventory;
  const counts = new Map();
  for (const item of inventory) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  const lines = [...counts.entries()].map(([name, count]) => `🎁 **${name}** × ${count}`);
  return baseEmbed(0x8b5cf6, `🎒 Инвентарь · ${userTag}`, lines.length ? lines.join('\n') : 'Твой инвентарь пока пуст.\n\nЗагляни в 🛒 магазин и приобрети первый товар.');
}

function findProduct(value) {
  const id = Number.parseInt(value, 10);
  if (Number.isInteger(id) && data.products[id] && data.products[id].active !== false) return data.products[id];
  const normalized = String(value || '').trim().toLowerCase();
  return productList().find(p => p.name.toLowerCase() === normalized);
}

function createPurchaseReply(target, ephemeral = false) {
  if (typeof target === 'function') return target;
  if (typeof target?.reply === 'function') {
    return content => target.reply(
      target.isChatInputCommand?.() || target.isButton?.()
        ? { content, ephemeral }
        : content,
    );
  }
  if (typeof target?.send === 'function') return content => target.send(content);
  return () => Promise.resolve();
}

async function buy(userId, value, target, options = {}) {
  const reply = createPurchaseReply(target, options.ephemeral);
  const product = findProduct(value);
  if (!product) return reply('❌ Товар не найден. Используй `/shop` или `!shop`.');
  const guild = target?.guild || _client?.guilds.cache.first();
  let member = null;

  // Ролевые товары проверяем ДО списания денег.
  if (product.roleId) {
    repairProductRole(product, guild);
    const check = checkRoleManageable(guild, product.roleId);
    if (!check.ok) return reply(`❌ Покупка недоступна: ${check.error}`);
    member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (!member) return reply('❌ Не удалось найти тебя на сервере.');
    if (member.roles.cache.has(product.roleId)) return reply('❌ У тебя уже есть эта роль.');
  }

  if (!debit(userId, product.price)) {
    return reply(`❌ Недостаточно монет. Нужно **${money(product.price)}**, баланс: **${money(balance(userId))}**`);
  }

  if (product.roleId) {
    const added = await member.roles.add(product.roleId, `Покупка товара #${product.id}`)
      .then(() => true)
      .catch(error => { console.error('Не удалось выдать роль при покупке:', error.message); return false; });
    if (!added) {
      credit(userId, product.price); // возврат средств
      return reply('❌ Не удалось выдать роль, деньги возвращены. Сообщи администрации.');
    }
  }

  const user = getUser(userId);
  user.inventory.push({ productId: product.id, name: product.name, roleId: product.roleId || null, purchasedAt: Date.now() });
  save();
  return reply(`✅ Куплен товар **${product.name}** за **${money(product.price)}**. Остаток: **${money(balance(userId))}**`);
}

function canManageEconomy(member) {
  return Boolean(
    member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
    member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    (_config?.ECONOMY_ADMIN_ROLE_ID && member?.roles?.cache?.has(_config.ECONOMY_ADMIN_ROLE_ID)),
  );
}

function createProduct({ name, price, description, roleId }) {
  const id = data.nextProductId++;
  data.products[id] = {
    id,
    name: String(name).trim().slice(0, 80),
    price: Math.floor(price),
    description: String(description || '').trim().slice(0, MAX_TEXT),
    roleId: roleId || null,
    active: true,
    createdAt: Date.now(),
  };
  save();
  return data.products[id];
}

function editProduct(id, patch) {
  const product = data.products[id];
  if (!product) return null;
  if (patch.name !== undefined) product.name = String(patch.name).trim().slice(0, 80);
  if (patch.price !== undefined) product.price = Math.floor(patch.price);
  if (patch.description !== undefined) product.description = String(patch.description).trim().slice(0, MAX_TEXT);
  if (patch.roleId !== undefined) product.roleId = patch.roleId || null;
  save();
  return product;
}

function deleteProduct(id) {
  if (!data.products[id]) return false;
  data.products[id].active = false;
  save();
  return true;
}

function productUsage() {
  return 'Админ-команды: `/product-create`, `/product-edit`, `/product-delete`';
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1_000_000_000 ? Math.floor(number) : null;
}

function commandDefinitions() {
  return [
    new SlashCommandBuilder().setName('dashboard').setDescription('Открыть красивую панель экономики'),
    new SlashCommandBuilder().setName('profile').setDescription('Открыть профиль')
      .addUserOption(o => o.setName('user').setDescription('Пользователь')),
    new SlashCommandBuilder().setName('shop').setDescription('Посмотреть магазин'),
    new SlashCommandBuilder().setName('buy').setDescription('Купить товар')
      .addStringOption(o => o.setName('item').setDescription('ID или точное название товара').setRequired(true)),
    new SlashCommandBuilder().setName('inventory').setDescription('Посмотреть инвентарь'),
    new SlashCommandBuilder().setName('product-create').setDescription('Создать товар')
      .addStringOption(o => o.setName('name').setDescription('Название').setRequired(true))
      .addIntegerOption(o => o.setName('price').setDescription('Цена').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Описание'))
      .addStringOption(o => o.setName('role').setDescription('ID роли, которую выдавать при покупке')),
    new SlashCommandBuilder().setName('product-edit').setDescription('Изменить товар')
      .addIntegerOption(o => o.setName('id').setDescription('ID товара').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Новое название'))
      .addIntegerOption(o => o.setName('price').setDescription('Новая цена').setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Новое описание'))
      .addStringOption(o => o.setName('role').setDescription('Новый ID роли')),
    new SlashCommandBuilder().setName('product-delete').setDescription('Скрыть товар из магазина')
      .addIntegerOption(o => o.setName('id').setDescription('ID товара').setMinValue(1).setRequired(true)),
    new SlashCommandBuilder().setName('role-sell').setDescription('Выставить роль на продажу в магазине (только разработчики)')
      .addRoleOption(o => o.setName('role').setDescription('Роль для продажи').setRequired(true))
      .addIntegerOption(o => o.setName('price').setDescription('Цена').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Описание товара')),
    new SlashCommandBuilder().setName('role-unsell').setDescription('Снять роль с продажи (только разработчики)')
      .addRoleOption(o => o.setName('role').setDescription('Роль').setRequired(true)),
    new SlashCommandBuilder().setName('role-listings').setDescription('Список ролей, выставленных на продажу'),
    new SlashCommandBuilder().setName('clwork').setDescription('Настроить роль, которая приносит деньги через /collect')
      .addRoleOption(o => o.setName('role').setDescription('Рабочая роль').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Сколько денег приносит').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('cooldown').setDescription('Кулдаун: 30m, 1h, 3h, 10h, 1d').setRequired(true)),
    new SlashCommandBuilder().setName('clwork-list').setDescription('Список рабочих ролей'),
    new SlashCommandBuilder().setName('clwork-remove').setDescription('Убрать рабочую роль')
      .addRoleOption(o => o.setName('role').setDescription('Роль').setRequired(true)),
    new SlashCommandBuilder().setName('collect').setDescription('Собрать деньги со своих рабочих ролей'),
  ].map(command => command.toJSON());
}

async function registerCommands() {
  const definitions = commandDefinitions();
  for (const guild of _client.guilds.cache.values()) {
    try {
      const existing = await guild.commands.fetch();
      for (const definition of definitions) {
        const current = existing.find(command => command.name === definition.name);
        if (current) await current.edit(definition);
        else await guild.commands.create(definition);
      }
    } catch (error) {
      console.error(`Не удалось зарегистрировать команды экономики на ${guild.name}:`, error.message);
    }
  }
}

function randomCard() {
  return randomInt(1, 11);
}

function blackjackTotal(cards) {
  let total = cards.reduce((sum, card) => sum + card, 0);
  return total;
}

async function blackjack(message, bet) {
  const game = { type: 'bj', userId: message.author.id, bet, player: [randomCard(), randomCard()], dealer: [randomCard(), randomCard()] };
  const id = holdGame(message.author.id, bet, game);
  if (!id) return message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
  const playerTotal = blackjackTotal(game.player);
  if (playerTotal === 21) {
    const payout = Math.floor(bet * 2.5);
    return finishGame(id, payout, `🃏 Blackjack! Ты набрал **21** и получил **${money(payout)}**. Баланс: **${money(balance(message.author.id) + payout)}**`, message, { reply: true });
  }
  game.message = await message.channel.send({
    embeds: [baseEmbed(0x5865f2, '🃏 Blackjack', `Твои карты: **${game.player.join(' + ')} = ${playerTotal}**\nКарта дилера: **${game.dealer[0]} + ?**\n\nСтавка: **${money(bet)}**`)],
    components: [gameButtons('bj', id)],
  });
}

async function finishBlackjack(interaction, game, id) {
  const playerTotal = blackjackTotal(game.player);
  if (playerTotal > 21) {
    return finishGame(id, 0, `💥 Перебор: **${playerTotal}**. Ты проиграл **${money(game.bet)}**.`, game.message);
  }
  while (blackjackTotal(game.dealer) < 17) game.dealer.push(randomCard());
  const dealerTotal = blackjackTotal(game.dealer);
  const payout = playerTotal > dealerTotal || dealerTotal > 21 ? game.bet * 2 : playerTotal === dealerTotal ? game.bet : 0;
  const result = payout === game.bet ? `🤝 Ничья. Ставка **${money(game.bet)}** возвращена.` :
    payout ? `🎉 Победа! Ты получил **${money(payout)}**.` : `❌ Ты проиграл **${money(game.bet)}**.`;
  finishGame(id, payout, `🃏 Blackjack\nТвои карты: **${game.player.join(' + ')} = ${playerTotal}**\nКарты дилера: **${game.dealer.join(' + ')} = ${dealerTotal}**\n${result}\nБаланс: **${money(balance(game.userId))}**`, game.message);
}

async function handleGameButton(interaction) {
  const [prefix, type, action, id] = interaction.customId.split(':');
  if (prefix !== 'eco') return false;
  if (type === 'panel') {
    const panelAction = action || 'home';
    const userObj = await resolveUser(interaction.user.id);
    if (panelAction === 'home' || panelAction === 'refresh') {
      return interaction.update(bannerPayload(homeEmbed(interaction.guild, userObj || interaction.user), 'home'));
    }
    if (panelAction === 'profile') {
      return interaction.update(profilePayload(interaction.user.id, userObj || interaction.user, 'profile'));
    }
    if (panelAction === 'shop') {
      return interaction.update(bannerPayload(shopEmbed(interaction.guild), 'shop', shopComponents()));
    }
    if (panelAction === 'inventory') {
      return interaction.update(bannerPayload(inventoryEmbed(interaction.user.id, interaction.user.tag), 'inventory'));
    }
    if (panelAction === 'top') {
      return interaction.update(bannerPayload(leaderboardEmbed(1), 'top'));
    }
    if (panelAction === 'bonus') {
      const user = getUser(interaction.user.id);
      const cooldown = 24 * 60 * 60 * 1000;
      const left = user.dailyAt + cooldown - Date.now();
      const available = left <= 0;
      const min = Number(_config?.ECONOMY_DAILY_MIN) || 500;
      const max = Number(_config?.ECONOMY_DAILY_MAX) || 1000;
      const embed = baseEmbed(0xf1c40f, '🎁 Ежедневный бонус', available
        ? `Тебя ждёт награда от **${money(min)}** до **${money(max)}**.`
        : `Следующий бонус будет доступен через **${formatLeft(left)}**.`)
        .addFields({ name: '💰 Текущий баланс', value: `**${money(user.cash)}**`, inline: true });
      const bonusRow = row(button('eco:panel:claimdaily', available ? '🎁 Забрать бонус' : '⏳ Недоступно', available ? ButtonStyle.Success : ButtonStyle.Secondary));
      return interaction.update(bannerPayload(embed, 'bonus', [bonusRow]));
    }
    if (panelAction === 'claimdaily') {
      const user = getUser(interaction.user.id);
      const cooldown = 24 * 60 * 60 * 1000;
      const left = user.dailyAt + cooldown - Date.now();
      if (left > 0) return interaction.reply({ content: `⏳ Бонус будет доступен через **${formatLeft(left)}**.`, ephemeral: true });
      const reward = randomInt(Number(_config?.ECONOMY_DAILY_MIN) || 500, Number(_config?.ECONOMY_DAILY_MAX) || 1000);
      user.dailyAt = Date.now();
      addCash(interaction.user.id, reward);
      return interaction.update(bannerPayload(baseEmbed(0x57f287, '🎉 Бонус получен!', `Ты забрал ежедневную награду **+${money(reward)}**.\n\n💰 Новый баланс: **${money(getUser(interaction.user.id).cash)}**`), 'bonus'));
    }
    return true;
  }
  if (type === 'buy') {
    const product = findProduct(action);
    if (!product) {
      await interaction.reply({ content: '❌ Этот товар больше недоступен.', ephemeral: true });
      return true;
    }
    await buy(interaction.user.id, action, interaction, { ephemeral: true });
    return true;
  }
  const game = games.get(id);
  if (type === 'duel') return handleDuelButton(interaction, action, id);
  if (!game) {
    await interaction.reply({ content: '⌛ Эта игра уже завершена.', ephemeral: true });
    return true;
  }
  if (game.userId !== interaction.user.id) {
    await interaction.reply({ content: '❌ Это не твоя игра.', ephemeral: true });
    return true;
  }
  await interaction.deferUpdate();
  if (type === 'bj') {
    if (action === 'hit') {
      game.player.push(randomCard());
      const total = blackjackTotal(game.player);
      if (total > 21) return finishGame(id, 0, `💥 Перебор: **${total}**. Ты проиграл **${money(game.bet)}**.`, game.message);
      return game.message.edit({ embeds: [baseEmbed(0x5865f2, '🃏 Blackjack', `Твои карты: **${game.player.join(' + ')} = ${total}**\nКарта дилера: **${game.dealer[0]} + ?**\n\nСтавка: **${money(game.bet)}**`)], components: [gameButtons('bj', id)] }).catch(() => {});
    }
    return finishBlackjack(interaction, game, id);
  }
  if (type === 'cf') {
    const result = randomInt(0, 1) === 0 ? 'heads' : 'tails';
    const win = action === result;
    const payout = win ? game.bet * 2 : 0;
    // Баланс считаем после начисления, иначе в сообщении показывался старый.
    const text = `🪙 Выпало **${result === 'heads' ? 'орёл' : 'решка'}**. ${win ? `Победа! +${money(payout)}` : `Проигрыш: ${money(game.bet)}`}`;
    return finishGame(id, payout, text, game.message, { balanceOf: game.userId });
  }
  if (type === 'roulette') {
    const number = randomInt(0, 36);
    const color = number === 0 ? 'green' : number % 2 ? 'red' : 'black';
    const payout = action === color ? (color === 'green' ? game.bet * 36 : game.bet * 2) : 0;
    const text = `🎰 Выпало **${number} (${color === 'green' ? 'зелёное' : color === 'red' ? 'красное' : 'чёрное'})**. ${payout ? `Победа! +${money(payout)}` : `Проигрыш: ${money(game.bet)}`}`;
    return finishGame(id, payout, text, game.message, { balanceOf: game.userId });
  }
  if (type === 'rps') {
    const botChoice = ['rock', 'paper', 'scissors'][randomInt(0, 2)];
    const win = (action === 'rock' && botChoice === 'scissors') || (action === 'paper' && botChoice === 'rock') || (action === 'scissors' && botChoice === 'paper');
    const tie = action === botChoice;
    const payout = win ? game.bet * 2 : tie ? game.bet : 0;
    const names = { rock: 'камень', paper: 'бумага', scissors: 'ножницы' };
    const text = `✂️ Ты выбрал **${names[action]}**, бот выбрал **${names[botChoice]}**.\n${win ? `Победа! +${money(payout)}` : tie ? `Ничья. Ставка возвращена.` : `Проигрыш: ${money(game.bet)}`}`;
    return finishGame(id, payout, text, game.message, { balanceOf: game.userId });
  }
  return false;
}

async function handleDuelButton(interaction, action, id) {
  const challenge = challenges.get(id);
  if (!challenge) {
    await interaction.reply({ content: '⌛ Эта дуэль уже завершена.', ephemeral: true });
    return true;
  }
  if (action === 'decline') {
    if (interaction.user.id !== challenge.targetId) {
      await interaction.reply({ content: '❌ Только приглашённый игрок может отклонить дуэль.', ephemeral: true });
      return true;
    }
    clearTimeout(challenge.timer);
    challenges.delete(id);
    credit(challenge.authorId, challenge.bet);
    await interaction.update({ content: `❌ <@${challenge.targetId}> отклонил дуэль. Ставка возвращена.`, components: [] });
    return true;
  }
  if (interaction.user.id !== challenge.targetId) {
    await interaction.reply({ content: '❌ Только приглашённый игрок может принять дуэль.', ephemeral: true });
    return true;
  }
  if (!debit(challenge.targetId, challenge.bet)) {
    clearTimeout(challenge.timer);
    challenges.delete(id);
    credit(challenge.authorId, challenge.bet);
    await interaction.update({ content: `❌ У приглашённого игрока недостаточно монет. Ставка возвращена.`, components: [] });
    return true;
  }
  clearTimeout(challenge.timer);
  challenges.delete(id);
  const winnerId = randomInt(0, 1) === 0 ? challenge.authorId : challenge.targetId;
  credit(winnerId, challenge.bet * 2);
  await interaction.update({
    content: `⚔️ Дуэль завершена!\nПобедитель: <@${winnerId}> получает **${money(challenge.bet * 2)}**.\nСтавка каждого игрока: **${money(challenge.bet)}**.`,
    components: [],
  });
  return true;
}

async function duel(message, args) {
  const bet = parseBet(args[0]);
  const target = message.mentions.users.first();
  if (!bet || !target || target.bot || target.id === message.author.id) {
    return message.reply('❌ Формат: `!duel 500 @user`');
  }
  if (!debit(message.author.id, bet)) return message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
  const id = token();
  const challenge = { authorId: message.author.id, targetId: target.id, bet };
  challenge.timer = setTimeout(() => {
    if (!challenges.has(id)) return;
    challenges.delete(id);
    credit(challenge.authorId, challenge.bet);
    // Раньше кнопки оставались активными и вводили в заблуждение.
    challenge.message?.edit({
      content: `⌛ Дуэль отменена: <@${challenge.targetId}> не ответил. Ставка ${money(challenge.bet)} возвращена.`,
      components: [],
    }).catch(() => {});
  }, GAME_TIMEOUT);
  challenges.set(id, challenge);
  const sent = await message.channel.send({
    content: `⚔️ <@${target.id}>, <@${message.author.id}> вызывает тебя на дуэль за **${money(bet)}**!`,
    components: [row(button(`eco:duel:accept:${id}`, 'Принять', ButtonStyle.Success), button(`eco:duel:decline:${id}`, 'Отклонить', ButtonStyle.Danger))],
  });
  challenge.message = sent;
  return sent;
}

async function simpleGame(message, type, bet) {
  if (!debit(message.author.id, bet)) return message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
  if (type === 'dice') {
    const player = randomInt(1, 6);
    const bot = randomInt(1, 6);
    const payout = player > bot ? bet * 2 : player === bot ? bet : 0;
    credit(message.author.id, payout);
    return message.reply(`🎲 Ты выбросил **${player}**, бот — **${bot}**. ${payout === bet ? 'Ничья, ставка возвращена.' : payout ? `Победа! +${money(payout)}` : `Проигрыш: ${money(bet)}`}\nБаланс: **${money(balance(message.author.id))}**`);
  }
  if (type === 'slots') {
    const symbols = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];
    const spin = [symbols[randomInt(0, 4)], symbols[randomInt(0, 4)], symbols[randomInt(0, 4)]];
    const payout = spin[0] === spin[1] && spin[1] === spin[2] ? (spin[0] === '7️⃣' ? bet * 25 : bet * 8) : spin[0] === spin[1] || spin[1] === spin[2] ? bet * 2 : 0;
    credit(message.author.id, payout);
    return message.reply(`🎰 ${spin.join(' | ')}. ${payout ? `Выигрыш: **${money(payout)}**` : `Проигрыш: ${money(bet)}`}\nБаланс: **${money(balance(message.author.id))}**`);
  }
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const prefix = _config.PREFIX || '!';
  const body = _config.stripPrefix ? _config.stripPrefix(message.content) : (message.content.startsWith(prefix) ? message.content.slice(prefix.length) : null);
  if (body === null) return;
  const args = body.trim().split(/\s+/);
  const command = (args.shift() || '').toLowerCase();
  if (!settings.isAllowed(message, command, _config)) {
    return message.reply(`⛔ Команда \`${prefix}${command}\` отключена или запрещена для тебя в этом канале.`);
  }
  if (settings.get().maintenance && !settings.isDeveloper(message.member, message.author.id, _config)) {
    return message.reply('🛠️ Бот находится на техническом обслуживании.');
  }
  if (command === 'money' || command === 'bal' || command === 'balance' || command === 'баланс') {
    const target = message.mentions.users.first() || message.author;
    const user = getUser(target.id);
    const rank = Object.entries(data.users)
      .map(([id, value]) => ({ id, total: Number(value.cash || value.balance || 0) + Number(value.bank || 0) }))
      .sort((a, b) => b.total - a.total)
      .findIndex(item => item.id === target.id) + 1;
    return message.reply(`💰 Баланс ${target.id === message.author.id ? 'твой' : `пользователя <@${target.id}>`}:\nНаличные: **${money(user.cash)}**\nБанк: **${money(user.bank)}**\nВсего: **${money(user.cash + user.bank)}**\nМесто в рейтинге: **#${rank || '—'}**`);
  }
  const bet = () => {
    const value = parseBet(args[0]);
    if (!value) {
      message.reply(`❌ Укажи корректную ставку. Пример: \`${prefix}${command} 500\``);
      return null;
    }
    const currentBalance = balance(message.author.id);
    if (value > currentBalance) {
      message.reply(`❌ У тебя нет **${money(value)}** для этой ставки.\n💰 Твой баланс: **${money(currentBalance)}**`);
      return null;
    }
    return value;
  };
  if (command === 'work') return work(message);
  if (command === 'rob' || command === 'ограбить') return rob(message);
  if (command === 'pay' || command === 'перевод') return pay(message, args);
  if (command === 'daily') return daily(message);
  if (command === 'weekly') return weekly(message);
  if (command === 'collect-income') return collectIncome(message);
  if (command === 'collect' || command === 'собрать') return collectWork(message);
  if (command === 'clwork') return clwork(message, args);
  if (command === 'deposit') {
    const amount = deposit(message.author.id, args[0]);
    return amount
      ? message.reply(`🏦 В банк внесено **${money(amount)}**. Наличные: **${money(getUser(message.author.id).cash)}**, банк: **${money(getUser(message.author.id).bank)}**`)
      : message.reply('❌ Укажи сумму или `all`. Проверь, что у тебя достаточно наличных и не превышен лимит банка.');
  }
  if (command === 'leaderboard' || command === 'топ') return leaderboard(message, args[0]);
  if (command === 'profile' || command === 'профиль') {
    const target = message.mentions.users.first() || message.author;
    return profile(message, target.id, target.tag);
  }
  if (command === 'rank' || command === 'уровень') {
    const target = message.mentions.users.first() || message.author;
    const progress = levelProgress(target.id);
    const account = getUser(target.id);
    return message.channel.send({
      embeds: [baseEmbed(0x8b5cf6, `🏆 Уровень · ${target.globalName || target.username}`,
        `\`${progress.bar}\` **${progress.percent}%** до следующего уровня`)
        .addFields(
          { name: '🏆 Уровень', value: `**${progress.level}**`, inline: true },
          { name: '⭐ XP', value: `**${account.xp}**`, inline: true },
          { name: '📈 Прогресс', value: `**${progress.current} / ${progress.needed}**`, inline: true },
        )],
    });
  }
  if (command === 'rep') {
    const target = message.mentions.users.first();
    if (!target || target.id === message.author.id || target.bot) return message.reply('❌ Укажи другого участника: `!rep @user`');
    return message.reply(addReputation(message.author.id, target.id)
      ? `⭐ Репутация пользователя <@${target.id}> повышена. Всего: **${reputation(target.id)}**`
      : '❌ Ты уже выдавал этому пользователю репутацию.');
  }
  if (command === 'withdraw') {
    if (!settings.isDeveloper(message.member, message.author.id, _config)) return message.reply('❌ Только разработчики.');
    const amount = withdraw(message.author.id, args[0]);
    return amount ? message.reply(`💵 Из банка снято **${money(amount)}**.`) : message.reply('❌ Укажи корректную сумму или `all`.');
  }
  if (command === 'give-money') {
    if (!settings.isDeveloper(message.member, message.author.id, _config)) return message.reply('❌ Только разработчики.');
    const target = message.mentions.users.first();
    const amount = parseNumber(args.find(value => /^\d[\d, ]*$/.test(value)));
    if (!target || !amount || target.bot) return message.reply('❌ Формат: `!give-money @user <сумма>`');
    if (!removeCash(message.author.id, amount, message.author.id)) return message.reply('❌ Недостаточно наличных.');
    addCash(target.id, amount, message.author.id);
    return message.reply(`✅ Ты передал <@${target.id}> **${money(amount)}**.`);
  }
  if (command === 'dashboard') return message.channel.send(bannerPayload(homeEmbed(message.guild, message.author), 'home'));
  if (command === 'shop') return message.channel.send(bannerPayload(shopEmbed(message.guild), 'shop', shopComponents()));
  if (command === 'inventory') return message.channel.send({ embeds: [inventoryEmbed(message.author.id, message.author.tag)] });
  if (command === 'buy') return buy(message.author.id, args.join(' '), message);
  if (command === 'bj' || command === 'blackjack') {
    const value = bet(); if (value) return blackjack(message, value);
  }
  if (command === 'cf' || command === 'coinflip') {
    const value = bet(); if (!value) return;
    const id = holdGame(message.author.id, value, { type: 'cf', userId: message.author.id, bet: value });
    if (!id) return message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
    const game = games.get(id);
    game.message = await message.channel.send({ embeds: [baseEmbed(0xffc857, '🪙 Орёл или решка', `Ставка: **${money(value)}**. Выбери сторону.`)], components: [gameButtons('cf', id)] });
  }
  if (command === 'dice') { const value = bet(); if (value) return simpleGame(message, 'dice', value); }
  if (command === 'roulette') {
    const value = bet(); if (!value) return;
    const id = holdGame(message.author.id, value, { type: 'roulette', userId: message.author.id, bet: value });
    if (!id) return message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
    games.get(id).message = await message.channel.send({ embeds: [baseEmbed(0xed4245, '🎰 Рулетка', `Ставка: **${money(value)}**. Выбери цвет.`)], components: [gameButtons('roulette', id)] });
  }
  if (command === 'slots') { const value = bet(); if (value) return simpleGame(message, 'slots', value); }
  if (command === 'duel') return duel(message, args);
  if (command === 'rps') {
    const value = bet(); if (!value) return;
    const id = holdGame(message.author.id, value, { type: 'rps', userId: message.author.id, bet: value });
    if (!id) return message.reply(`❌ Недостаточно монет. Баланс: **${money(balance(message.author.id))}**`);
    games.get(id).message = await message.channel.send({ embeds: [baseEmbed(0x5865f2, '✂️ Камень, ножницы, бумага', `Ставка: **${money(value)}**. Сделай выбор.`)], components: [gameButtons('rps', id)] });
  }
}

function interactionAsMessage(interaction) {
  return {
    guild: interaction.guild,
    member: interaction.member,
    author: interaction.user,
    channel: interaction.channel,
    mentions: { users: { first: () => null }, roles: { first: () => null }, channels: { first: () => null } },
    reply: payload => interaction.reply(typeof payload === 'string' ? { content: payload } : payload),
  };
}

async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith('eco:')) return handleGameButton(interaction);
  if (!interaction.isChatInputCommand()) return;
  const command = interaction.commandName;
  if (command === 'dashboard') return interaction.reply(bannerPayload(homeEmbed(interaction.guild, interaction.user), 'home'));
  if (command === 'profile') { const target = interaction.options.getUser('user') || interaction.user; return interaction.reply(profilePayload(target.id, target, 'profile')); }
  if (command === 'shop') return interaction.reply(bannerPayload(shopEmbed(interaction.guild), 'shop', shopComponents()));
  if (command === 'inventory') return interaction.reply({ embeds: [inventoryEmbed(interaction.user.id, interaction.user.tag)] });
  if (command === 'buy') return buy(interaction.user.id, interaction.options.getString('item'), interaction);
  if (command === 'clwork' || command === 'clwork-list' || command === 'clwork-remove' || command === 'collect') {
    const fake = interactionAsMessage(interaction);
    if (command === 'collect') return collectWork(fake);
    if (command === 'clwork-list') return clwork(fake, ['list']);
    if (command === 'clwork-remove') return clwork(fake, ['remove', interaction.options.getRole('role').id]);
    return clwork(fake, [
      interaction.options.getRole('role').id,
      String(interaction.options.getInteger('amount')),
      interaction.options.getString('cooldown'),
    ]);
  }
  if (command === 'role-listings') {
    return interaction.reply({ embeds: [roleListingsEmbed(interaction.guild)] });
  }
  if (command === 'role-sell' || command === 'role-unsell') {
    if (!isDeveloperMember(interaction.member, interaction.user.id)) {
      return interaction.reply({ content: '❌ Продавать роли могут только разработчики.', ephemeral: true });
    }
    const role = interaction.options.getRole('role');
    if (command === 'role-unsell') {
      const listing = findRoleListing(role.id, interaction.guild);
      if (!listing) {
        return interaction.reply({
          content: `❌ Эта роль не выставлена на продажу. Если товар создавали через \`/product-create\`, удали его командой \`/product-delete id:<номер из /shop>\`.`,
          ephemeral: true,
        });
      }
      deleteProduct(listing.id);
      return interaction.reply(`✅ Роль **${role.name}** снята с продажи (товар #${listing.id}).`);
    }
    const check = checkRoleManageable(interaction.guild, role.id);
    if (!check.ok) return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
    const price = interaction.options.getInteger('price');
    const description = interaction.options.getString('description') || `Покупка выдаёт роль ${role.name}.`;
    const existing = findRoleListing(role.id, interaction.guild);
    if (existing) {
      editProduct(existing.id, { price, description, name: role.name });
      return interaction.reply(`✅ Роль **${role.name}** уже в продаже — цена обновлена: **${money(price)}** (товар #${existing.id}).`);
    }
    const product = createProduct({ name: role.name, price, description, roleId: role.id });
    return interaction.reply(`✅ Роль **${role.name}** выставлена на продажу за **${money(price)}** (товар #${product.id}). Купить можно кнопкой в \`/shop\`.`);
  }
  if (command.startsWith('product-')) {
    if (!canManageEconomy(interaction.member)) return interaction.reply({ content: '❌ Недостаточно прав.', ephemeral: true });
    if (command === 'product-create') {
      const roleInput = interaction.options.getString('role');
      const roleId = roleInput ? normalizeRoleId(interaction.guild, roleInput) : null;
      if (roleInput && !roleId) {
        return interaction.reply({ content: '❌ Роль не найдена на этом сервере. Укажи ID роли или используй `/role-sell`.', ephemeral: true });
      }
      if (roleId) {
        const check = checkRoleManageable(interaction.guild, roleId);
        if (!check.ok) return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
      }
      const product = createProduct({
        name: interaction.options.getString('name'),
        price: interaction.options.getInteger('price'),
        description: interaction.options.getString('description'),
        roleId,
      });
      return interaction.reply(`✅ Товар **#${product.id} ${product.name}** создан за **${money(product.price)}**.`);
    }
    if (command === 'product-edit') {
      const id = interaction.options.getInteger('id');
      const roleInput = interaction.options.getString('role');
      let roleId;
      if (roleInput !== null) {
        roleId = normalizeRoleId(interaction.guild, roleInput);
        if (!roleId) return interaction.reply({ content: '❌ Роль не найдена на этом сервере.', ephemeral: true });
        const check = checkRoleManageable(interaction.guild, roleId);
        if (!check.ok) return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
      }
      const product = editProduct(id, {
        name: interaction.options.getString('name'),
        price: interaction.options.getInteger('price'),
        description: interaction.options.getString('description'),
        roleId,
      });
      return interaction.reply(product ? `✅ Товар **#${id}** изменён.` : '❌ Товар не найден.');
    }
    if (command === 'product-delete') {
      const deleted = deleteProduct(interaction.options.getInteger('id'));
      return interaction.reply(deleted ? '✅ Товар скрыт из магазина.' : '❌ Товар не найден.');
    }
  }
}

function init(client, config) {
  _client = client;
  _config = config;
  load();
  client.on('messageCreate', message => handleMessage(message).catch(error => console.error('Ошибка экономики:', error)));
  client.on('interactionCreate', interaction => handleInteraction(interaction).catch(error => console.error('Ошибка interaction экономики:', error)));
  console.log('✅ Экономика загружена');
}

module.exports = {
  init, registerCommands, productUsage,
  setWorkRole, removeWorkRole, workRoles,
  getUser, money, balance, peek, totalBalance, addMoney, removeMoney,
  deposit, withdraw, setCurrency, resetUser, resetEconomy, setIncome,
  stats, exportData, importData, reputation, addReputation, userRank,
};
