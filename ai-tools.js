// ── Инструменты ИИ (function calling) ───────────────────────────────────────
// Дают ИИ доступ к живым данным сервера: роли, участники, команды, статистика.
// Все инструменты только читают данные — ничего не изменяют.
const config = require('./config');
const { COMMANDS, KNOWLEDGE } = require('./ai-knowledge');
const { STAFF_ROLES } = require('./ai-roles');

let db = null;
try { db = require('./database'); } catch { db = null; }
let economy = null;
try { economy = require('./economy'); } catch { economy = null; }

const MAX_LIST = 80;

function normalize(text) {
  return (text || '').toLowerCase().replace(/[ёЁ]/g, 'е').trim();
}

function statusOf(member) {
  const status = member.presence?.status;
  return status && status !== 'offline' ? 'в сети' : 'не в сети';
}

function label(member) {
  return `${member.displayName || member.user.username} (@${member.user.username}, id ${member.id}, ${statusOf(member)})`;
}

async function allMembers(guild) {
  try {
    return await guild.members.fetch();
  } catch (error) {
    console.error('❌ Не удалось загрузить участников:', error.message);
    return guild.members.cache;
  }
}

/** Ищет роль по ID, упоминанию <@&id> или части названия. */
function resolveRole(guild, query) {
  const raw = (query || '').trim();
  const byMention = raw.match(/^<@&(\d+)>$/);
  const id = byMention ? byMention[1] : raw;
  if (/^\d{5,}$/.test(id)) {
    const role = guild.roles.cache.get(id);
    if (role) return role;
  }
  const clean = normalize(raw);
  if (!clean) return null;

  // Сначала — штатные роли по ключевым словам из ai-roles.js
  for (const staff of STAFF_ROLES) {
    if (staff.keywords.some(word => clean.includes(normalize(word)))) {
      const role = guild.roles.cache.get(staff.id);
      if (role) return role;
    }
  }
  const roles = [...guild.roles.cache.values()];
  return (
    roles.find(role => normalize(role.name) === clean) ||
    roles.find(role => normalize(role.name).includes(clean)) ||
    roles.find(role => clean.includes(normalize(role.name)) && role.name.length > 2) ||
    null
  );
}

/** Ищет участника по ID, упоминанию, нику или отображаемому имени. */
function resolveMember(members, query) {
  const raw = (query || '').trim();
  const byMention = raw.match(/^<@!?(\d+)>$/);
  const id = byMention ? byMention[1] : raw;
  if (/^\d{5,}$/.test(id) && members.has(id)) return members.get(id);

  const clean = normalize(raw).replace(/^@/, '');
  if (!clean) return null;
  const list = [...members.values()];
  return (
    list.find(m => normalize(m.user.username) === clean) ||
    list.find(m => normalize(m.displayName) === clean) ||
    list.find(m => normalize(m.user.username).includes(clean)) ||
    list.find(m => normalize(m.displayName).includes(clean)) ||
    null
  );
}

const TOOLS = {
  /** Сканирует участников с указанной ролью. */
  async scan_role_members({ role: roleQuery }, { guild }) {
    if (!guild) return 'Нет данных о сервере.';
    const role = resolveRole(guild, roleQuery);
    if (!role) return `Роль «${roleQuery}» на сервере не найдена. Используй list_roles, чтобы увидеть доступные роли.`;

    const members = await allMembers(guild);
    const holders = members
      .filter(member => member.roles.cache.has(role.id))
      .map(label)
      .sort((a, b) => a.localeCompare(b, 'ru'));

    if (!holders.length) return `Роль «${role.name}» (id ${role.id}): сейчас никто её не имеет.`;
    const shown = holders.slice(0, MAX_LIST);
    return (
      `Роль «${role.name}» (id ${role.id}), участников: ${holders.length}\n` +
      shown.map(item => `- ${item}`).join('\n') +
      (holders.length > shown.length ? `\n…и ещё ${holders.length - shown.length}` : '')
    );
  },

  /** Полная карточка участника: роли, даты, варны, баланс. */
  async get_member_info({ user }, { guild }) {
    if (!guild) return 'Нет данных о сервере.';
    const members = await allMembers(guild);
    const member = resolveMember(members, user);
    if (!member) return `Участник «${user}» не найден на сервере.`;

    const roles = member.roles.cache
      .filter(role => role.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(role => `${role.name} (id ${role.id})`);

    const lines = [
      `Имя: ${member.displayName} (@${member.user.username}, id ${member.id})`,
      `Статус: ${statusOf(member)}`,
      `Зашёл на сервер: ${member.joinedAt ? member.joinedAt.toLocaleDateString('ru-RU') : 'неизвестно'}`,
      `Аккаунт создан: ${member.user.createdAt.toLocaleDateString('ru-RU')}`,
      `Роли (${roles.length}): ${roles.length ? roles.join(', ') : 'нет ролей'}`,
    ];

    try {
      const warns = db?.getWarns?.(guild.id, member.id);
      if (Array.isArray(warns)) lines.push(`Предупреждений: ${warns.length}`);
    } catch { /* модуль варнов недоступен */ }

    try {
      // peek: не создаёт экономический аккаунт как побочный эффект чтения
      const balance = economy?.peek?.(member.id);
      if (balance && typeof balance === 'object') {
        lines.push(`Баланс: ${balance.cash ?? 0} наличными, ${balance.bank ?? 0} в банке (${config.ECONOMY_CURRENCY})`);
      } else if (typeof balance === 'number') {
        lines.push(`Баланс: ${balance} ${config.ECONOMY_CURRENCY}`);
      }
    } catch { /* экономика недоступна */ }

    return lines.join('\n');
  },

  /** Список ролей сервера с количеством участников. */
  async list_roles({ query }, { guild }) {
    if (!guild) return 'Нет данных о сервере.';
    const clean = normalize(query);
    const roles = [...guild.roles.cache.values()]
      .filter(role => role.id !== guild.id)
      .filter(role => !clean || normalize(role.name).includes(clean))
      .sort((a, b) => b.position - a.position)
      .slice(0, MAX_LIST)
      .map(role => `- ${role.name} (id ${role.id}, участников: ${role.members.size})`);
    return roles.length ? `Роли сервера:\n${roles.join('\n')}` : 'Подходящих ролей не найдено.';
  },

  /** Поиск по справочнику команд бота. */
  async list_commands({ query }) {
    const clean = normalize(query);
    if (!clean) return COMMANDS.slice(0, 12000);
    const lines = COMMANDS.split('\n').filter(line => normalize(line).includes(clean));
    if (!lines.length) {
      const fallback = KNOWLEDGE.split('\n').filter(line => normalize(line).includes(clean));
      return fallback.length
        ? fallback.slice(0, 40).join('\n')
        : `По запросу «${query}» команд не найдено. Не выдумывай команду — так и скажи.`;
    }
    return lines.slice(0, 40).join('\n');
  },

  /** Общая информация о сервере. */
  async server_info(_args, { guild }) {
    if (!guild) return 'Нет данных о сервере.';
    const members = await allMembers(guild);
    const online = members.filter(member => statusOf(member) === 'в сети').size;
    const bots = members.filter(member => member.user.bot).size;
    return [
      `Сервер: ${guild.name} (id ${guild.id})`,
      `Участников: ${members.size} (в сети: ${online}, ботов: ${bots})`,
      `Ролей: ${guild.roles.cache.size}`,
      `Каналов: ${guild.channels.cache.size}`,
      `Создан: ${guild.createdAt.toLocaleDateString('ru-RU')}`,
      `Префикс команд бота: ${config.PREFIX}`,
    ].join('\n');
  },

  /** Кто задал вопрос — роли и права спрашивающего. */
  async whoami(_args, { guild, member }) {
    if (!member) return 'Не удалось определить автора сообщения.';
    return TOOLS.get_member_info({ user: member.id }, { guild });
  },
};

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'scan_role_members',
      description: 'Просканировать сервер и получить список участников с указанной ролью (включая тех, кто не в сети). Использовать всегда, когда спрашивают «кто модератор / кто имеет роль X / состав».',
      parameters: {
        type: 'object',
        properties: { role: { type: 'string', description: 'Название роли, её ID или упоминание <@&id>' } },
        required: ['role'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_member_info',
      description: 'Получить карточку участника: все его роли, дату входа, статус, число предупреждений и баланс. Использовать, когда спрашивают «какие роли у X», «кто такой X», «есть ли у X роль».',
      parameters: {
        type: 'object',
        properties: { user: { type: 'string', description: 'Ник, отображаемое имя, ID или упоминание участника' } },
        required: ['user'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_roles',
      description: 'Список ролей сервера с количеством участников. Можно передать часть названия для поиска.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Часть названия роли (необязательно)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_commands',
      description: 'Найти команды бота и описание того, кому они доступны. Использовать при любом вопросе про команды бота.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Ключевое слово: название команды или тема (варн, экономика, тикет...)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'server_info',
      description: 'Общая статистика сервера: количество участников, ролей, каналов, дата создания.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'whoami',
      description: 'Данные о пользователе, который сейчас пишет боту: его роли и права.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** Выполняет инструмент по имени. Всегда возвращает строку. */
async function runTool(name, args, context) {
  const tool = TOOLS[name];
  if (!tool) return `Инструмент «${name}» не существует.`;
  try {
    const result = await tool(args || {}, context);
    return String(result ?? '').slice(0, 6000) || 'Пустой результат.';
  } catch (error) {
    console.error(`❌ Ошибка инструмента ИИ ${name}:`, error.message);
    return `Ошибка при выполнении «${name}»: ${error.message}`;
  }
}

module.exports = { TOOL_SCHEMAS, runTool, resolveRole, resolveMember };
