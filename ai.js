// ── ИИ-ассистент на Groq API ────────────────────────────────────────────────
// Отвечает на сообщения пользователей в указанных каналах.
// Экономит токены (лимиты Groq TPM/TPD) и умеет переживать 429:
//   • короткий системный промпт, справочник команд подгружается инструментом;
//   • ретрай с ожиданием, если Groq просит подождать пару секунд (TPM);
//   • переход на запасную модель, если исчерпан дневной лимит (TPD).
const config = require('./config');
const { SHORT_KNOWLEDGE } = require('./ai-knowledge');
const { buildRolesContext, ROLES_FACTS } = require('./ai-roles');
const { TOOL_SCHEMAS, runTool } = require('./ai-tools');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// История диалога по каналам: channelId -> [{role, content}, ...]
const history = new Map();
// Каналы, где ответ уже генерируется (чтобы не спамить параллельно)
const busy = new Set();
// Личный кулдаун: userId -> timestamp последнего запроса
const lastAsk = new Map();
// Модели, у которых кончился дневной лимит: model -> timestamp, когда снова можно
const cooldownUntil = new Map();

function getHistory(channelId) {
  if (!history.has(channelId)) history.set(channelId, []);
  return history.get(channelId);
}

function pushHistory(channelId, role, content) {
  const list = getHistory(channelId);
  list.push({ role, content: String(content).slice(0, 1500) });
  const max = config.AI_HISTORY_LIMIT * 2;
  while (list.length > max) list.shift();
}

function resetHistory(channelId) {
  history.delete(channelId);
}

function isAiChannel(channelId) {
  // Если каналы не заданы — ИИ работает в любом канале, но только по упоминанию бота.
  if (!config.AI_CHANNEL_IDS.length) return true;
  return config.AI_CHANNEL_IDS.includes(channelId);
}

const TOOLS_PROMPT = `
Инструменты (живые данные сервера): scan_role_members, get_member_info, list_roles,
list_commands, server_info, whoami.
Правила: вопрос про роли, участников, состав, права или команды — сначала вызови
инструмент и отвечай ТОЛЬКО по его результату. Про любые команды бота обязательно
вызывай list_commands: справочника в промпте нет, выдумывать команды нельзя.
Инструменты только читают данные.
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Список моделей: основная + запасные (более дешёвые по токенам). */
function modelChain() {
  const chain = [config.AI_MODEL, ...config.AI_FALLBACK_MODELS];
  return chain.filter((model, index) => model && chain.indexOf(model) === index);
}

/** Достаёт из текста ошибки Groq время ожидания в миллисекундах. */
function parseRetryAfter(body) {
  const match = /try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i.exec(body || '');
  if (!match) return null;
  const minutes = Number(match[1] || 0);
  const seconds = Number(match[2] || 0);
  return Math.round((minutes * 60 + seconds) * 1000);
}

function isDailyLimit(body) {
  return /per day|TPD|RPD/i.test(body || '');
}

class RateLimitError extends Error {
  constructor(waitMs) {
    super(`Groq API 429 (ждать ${Math.ceil((waitMs || 0) / 1000)}с)`);
    this.waitMs = waitMs || 0;
    this.rateLimited = true;
  }
}

async function requestGroq(model, messages) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: 'auto',
      temperature: config.AI_TEMPERATURE,
      max_tokens: config.AI_MAX_TOKENS,
    }),
  });

  if (response.status === 429) {
    const body = await response.text();
    const waitMs = parseRetryAfter(body) ?? 5000;
    if (isDailyLimit(body)) {
      cooldownUntil.set(model, Date.now() + waitMs);
      console.warn(`⚠️ Дневной лимит модели ${model}, пауза ${Math.ceil(waitMs / 1000)}с`);
      const error = new RateLimitError(waitMs);
      error.daily = true;
      throw error;
    }
    throw new RateLimitError(waitMs);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq API ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

/**
 * Вызов Groq с ретраями по TPM и переключением на запасную модель по TPD.
 */
async function callGroq(messages) {
  let lastError = null;
  for (const model of modelChain()) {
    const until = cooldownUntil.get(model) || 0;
    if (until > Date.now()) { // модель на дневной паузе — сразу к следующей
      lastError = new RateLimitError(until - Date.now());
      lastError.daily = true;
      continue;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return { data: await requestGroq(model, messages), model };
      } catch (error) {
        lastError = error;
        if (!error.rateLimited || error.daily) break; // дневной лимит — меняем модель
        if (error.waitMs > config.AI_MAX_WAIT_MS) break;
        await sleep(error.waitMs + 300);
      }
    }
  }
  throw lastError || new Error('Groq недоступен');
}

/** Приблизительная оценка токенов, чтобы не отправлять лишнее. */
function trimToolResult(text) {
  const limit = config.AI_TOOL_RESULT_LIMIT;
  const value = String(text || '');
  return value.length > limit ? `${value.slice(0, limit)}\n…(список обрезан)` : value;
}

async function askGroq(channelId, userText, userName, guild, member) {
  const rolesContext = await buildRolesContext(guild, userText);
  const system = [config.AI_SYSTEM_PROMPT, TOOLS_PROMPT, SHORT_KNOWLEDGE, ROLES_FACTS, rolesContext]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system', content: system },
    ...getHistory(channelId),
    { role: 'user', content: `${userName}: ${userText}` },
  ];

  let text = '';
  for (let step = 0; step < config.AI_MAX_TOOL_STEPS; step++) {
    const { data } = await callGroq(messages);
    const reply = data?.choices?.[0]?.message;
    if (!reply) throw new Error('Groq вернул пустой ответ');

    const calls = reply.tool_calls || [];
    if (!calls.length) {
      text = (reply.content || '').trim();
      break;
    }

    messages.push({ role: 'assistant', content: reply.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      const result = await runTool(call.function.name, args, { guild, member });
      console.log(`🔧 ИИ вызвал ${call.function.name}(${JSON.stringify(args)})`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: trimToolResult(result),
      });
    }
  }

  if (!text) throw new Error('Groq вернул пустой ответ');

  pushHistory(channelId, 'user', `${userName}: ${userText}`);
  pushHistory(channelId, 'assistant', text);

  return text;
}

// Discord не принимает сообщения длиннее 2000 символов
function chunk(text, size = 1900) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function humanWait(ms) {
  const seconds = Math.ceil((ms || 0) / 1000);
  if (seconds < 60) return `${seconds} сек.`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} мин.`;
}

/**
 * Обрабатывает сообщение. Возвращает true, если сообщение было обработано ИИ
 * (значит, остальные команды бота его игнорируют).
 */
async function handleMessage(message) {
  if (!config.AI_ENABLED) return false;
  if (!isAiChannel(message.channel.id)) return false;
  // Без списка AI_CHANNEL_IDS отвечаем только на прямое упоминание бота.
  if (!config.AI_CHANNEL_IDS.length && !message.mentions.has(message.client.user)) return false;

  const content = (message.content || '').trim();
  if (!content) return false;

  // Служебные команды бота в ИИ-канале не перехватываем
  const cmdBody = config.stripPrefix(content);
  if (cmdBody !== null) {
    const cmd = cmdBody.trim().split(/\s+/)[0].toLowerCase();
    if (cmd === 'ai-reset' || cmd === 'сброс') {
      resetHistory(message.channel.id);
      await message.reply('🧠 История диалога очищена.').catch(() => {});
      return true;
    }
    return false;
  }

  if (!config.GROQ_API_KEY) {
    await message.reply('⚠️ ИИ не настроен: не задан GROQ_API_KEY.').catch(() => {});
    return true;
  }

  // Личный кулдаун — главная защита от выжигания дневного лимита
  const cooldown = config.AI_USER_COOLDOWN_MS;
  const last = lastAsk.get(message.author.id) || 0;
  if (cooldown > 0 && Date.now() - last < cooldown) {
    await message.react('⏳').catch(() => {});
    return true;
  }
  lastAsk.set(message.author.id, Date.now());

  if (busy.has(message.channel.id)) return true;
  busy.add(message.channel.id);

  try {
    await message.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

    try {
      const name = message.member?.displayName || message.author.username;
      const answer = await askGroq(message.channel.id, content, name, message.guild, message.member);
      const parts = chunk(answer);
      await message.reply({ content: parts[0], allowedMentions: { repliedUser: true, parse: [] } });
      for (const part of parts.slice(1)) {
        await message.channel.send({ content: part, allowedMentions: { parse: [] } });
      }
    } finally {
      clearInterval(typing);
    }
  } catch (error) {
    console.error('❌ Ошибка ИИ:', error.message);
    let text = '❌ Не удалось получить ответ от ИИ. Попробуй ещё раз позже.';
    if (error.rateLimited || /429/.test(error.message)) {
      text = error.daily
        ? `🚦 Дневной лимит токенов ИИ исчерпан. Он восстановится примерно через ${humanWait(error.waitMs)}.`
        : `⏳ Слишком много запросов к ИИ. Попробуй через ${humanWait(error.waitMs || 30000)}.`;
    }
    await message.reply(text).catch(() => {});
  } finally {
    busy.delete(message.channel.id);
  }

  return true;
}

module.exports = { handleMessage, resetHistory, isAiChannel };
