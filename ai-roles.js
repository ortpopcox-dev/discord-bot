// ── Штатные роли сервера для ИИ ─────────────────────────────────────────────
// ID ролей задаются переменными окружения AI_ROLE_*_ID (см. .env.example).
const config = require('./config');
const STAFF_IDS = config.AI_STAFF_ROLE_IDS || {};
// ИИ умеет отвечать «кто модератор / кто легендарный модератор / кто зам / кто
// директор», сканируя участников с нужной ролью (включая тех, кто не в сети).

const ALL_STAFF_ROLES = [
  {
    key: 'moderator',
    id: STAFF_IDS.moderator || '',
    title: 'Модератор сервера',
    description: 'Следят за порядком в чатах: варны, муты, чистка сообщений.',
    keywords: [
      'кто модератор', 'кто модер', 'модераторы сервера', 'кто модеры',
      'список модераторов', 'кто мод ', 'модерский состав', 'кто из модеров',
      'модератор', 'модеры', 'модерка',
    ],
  },
  {
    key: 'legendary',
    id: STAFF_IDS.legendary || '',
    title: 'Легендарные модераторы',
    description: 'Заслуженные модераторы сервера — особая почётная роль долгую и качественную работу.',
    keywords: [
      'легендарные модераторы', 'легендарный модератор', 'легенда модер',
      'что за роль легендарные', 'кто легендарные', 'легендарные модеры',
      'легендарка', 'легендарный мод',
    ],
  },
  {
    key: 'deputy',
    id: STAFF_IDS.deputy || '',
    title: 'Заместители',
    description: 'Помогаторы влада420 — помогают овнеру управлять сервером.',
    keywords: [
      'кто такие заместители', 'кто заместители', 'кто зам', 'кто замы',
      'заместитель', 'заместители', 'замы', 'что за роль зам',
    ],
  },
  {
    key: 'director',
    id: STAFF_IDS.director || '',
    title: 'Директор',
    description: 'Помогаторы влада420 с большими правами — почти полный доступ к управлению сервером.',
    keywords: [
      'кто такой директор', 'кто директор', 'кто директора', 'директор',
      'директора', 'что за роль директор',
    ],
  },
];

// В работу попадают только роли, для которых указан ID.
const STAFF_ROLES = ALL_STAFF_ROLES.filter(role => role.id);

const ROLES_BY_ID = new Map(STAFF_ROLES.map(role => [role.id, role]));

function normalize(text) {
  return (text || '').toLowerCase().replace(/[ёЁ]/g, 'е').replace(/\s+/g, ' ');
}

/** Определяет, о каких штатных ролях спрашивает пользователь. */
function detectRoles(text) {
  const clean = normalize(text);
  const found = [];
  for (const role of STAFF_ROLES) {
    if (clean.includes(role.id)) { found.push(role); continue; }
    if (role.keywords.some(word => clean.includes(normalize(word)))) found.push(role);
  }
  // Если спросили «кто состав / кто админстрация» — отдаём всё
  if (!found.length && /(состав|администрац|стафф|staff|персонал|кто у вас главн)/.test(clean)) {
    return [...STAFF_ROLES];
  }
  return found;
}

function memberLabel(member) {
  const name = member.displayName || member.user.username;
  const status = member.presence?.status;
  const online = status && status !== 'offline' ? 'в сети' : 'не в сети';
  return `${name} (@${member.user.username}, ${online})`;
}

/**
 * Собирает список участников для указанных ролей.
 * Возвращает текстовый блок для системного промпта ИИ (или пустую строку).
 */
async function buildRolesContext(guild, text) {
  if (!guild) return '';
  const roles = detectRoles(text);
  if (!roles.length) return '';

  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    console.error('❌ Не удалось загрузить участников для ИИ:', error.message);
    return '';
  }

  const blocks = [];
  for (const role of roles) {
    const holders = members
      .filter(member => member.roles.cache.has(role.id))
      .map(memberLabel)
      .sort((a, b) => a.localeCompare(b, 'ru'));

    blocks.push(
      `Роль «${role.title}» (ID ${role.id}) — ${role.description}\n` +
      (holders.length
        ? `Участники с этой ролью (${holders.length}), перечисли их все, независимо от того, в сети они или нет:\n- ${holders.join('\n- ')}`
        : 'Сейчас никто не имеет эту роль.')
    );
  }

  return (
    '\nАКТУАЛЬНЫЕ ДАННЫЕ О СОСТАВЕ СЕРВЕРА (получено прямо сейчас сканированием ролей, ' +
    'используй именно эти имена и не выдумывай других):\n' +
    blocks.join('\n\n') + '\n'
  );
}

const ROLES_FACTS = STAFF_ROLES.length ? `
ШТАТНЫЕ РОЛИ СЕРВЕРА:
${STAFF_ROLES.map(r => `- «${r.title}» (ID ${r.id}) — ${r.description}`).join('\n')}
Если спрашивают, кто имеет одну из этих ролей — назови участников из блока
«АКТУАЛЬНЫЕ ДАННЫЕ О СОСТАВЕ СЕРВЕРА», включая тех, кто сейчас не в сети.
Если такого блока нет — скажи, что не удалось получить список, и предложи спросить ещё раз.
` : '';

module.exports = { STAFF_ROLES, ROLES_BY_ID, detectRoles, buildRolesContext, ROLES_FACTS };
