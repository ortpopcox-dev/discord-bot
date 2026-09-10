const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const store = require('./store');

const KEY = 'new-posts';
const NEW_CHANNEL_ID = '1547615885320134686';
const NEW_DEVELOPER_ROLE_ID = '1486307269254709248';
const NEW_PING_ROLE_ID = '1547634726989336597';
const DRAFT_TTL_MS = 15 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_TITLE_LENGTH = 256;
const MAX_CONTENT_LENGTH = 4000;

let client = null;
let config = null;
let timer = null;
const drafts = new Map();

function loadPosts() {
  const parsed = store.read(KEY, null);
  return Array.isArray(parsed) ? parsed : [];
}

let posts = [];

function savePosts() {
  store.write(KEY, posts);
}

function canUseNewCommand(member) {
  return Boolean(member?.roles?.cache?.has?.(NEW_DEVELOPER_ROLE_ID));
}


function baseEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTimestamp();
}

function buildPanel() {
  return {
    embeds: [baseEmbed()
      .setTitle('🆕 Создание публикации')
      .setDescription(
        '**Новая публикация для сервера**\n\n' +
        'Нажми кнопку ниже, чтобы открыть редактор.\n' +
        'После создания можно отправить публикацию **сразу** или **запланировать** её на нужное время.\n\n' +
        `📍 Канал публикации: <#${NEW_CHANNEL_ID}>`
      )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('newpost_create')
        .setLabel('📝 Создать публикацию')
        .setStyle(ButtonStyle.Primary),
    )],
  };
}

function buildPreview(draft) {
  const preview = baseEmbed()
    .setTitle(`🆕 ${draft.title}`)
    .setDescription(draft.content)
    .addFields(
      { name: '👨‍💻 Автор', value: `<@${draft.authorId}>`, inline: true },
      { name: '📍 Канал', value: `<#${NEW_CHANNEL_ID}>`, inline: true },
      { name: '📤 Статус', value: 'Готово к отправке', inline: true },
    )
    .setFooter({ text: 'Предпросмотр публикации • доступно только разработчикам' });

  return {
    embeds: [preview],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('newpost_send')
        .setLabel('⚡ Отправить сейчас')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('newpost_schedule')
        .setLabel('🕐 Выбрать время')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('newpost_cancel')
        .setLabel('❌ Отменить')
        .setStyle(ButtonStyle.Danger),
    )],
  };
}

function parseDateTime(input) {
  const normalized = String(input || '').trim().replace('T', ' ');
  let match = normalized.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  let year;
  let month;
  let day;
  let hour;
  let minute;

  if (match) {
    [, year, month, day, hour, minute] = match.map(Number);
  } else {
    match = normalized.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    [, day, month, year, hour, minute] = match.map(Number);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  // Сервер использует московское время (UTC+3), как и существующая система ивентов.
  const timestamp = Date.UTC(year, month - 1, day, hour - 3, minute, 0, 0);
  const check = new Date(timestamp);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) return null;

  return timestamp;
}

function formatScheduled(timestamp) {
  const unix = Math.floor(timestamp / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function cleanExpiredDrafts() {
  const now = Date.now();
  for (const [userId, draft] of drafts) {
    if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(userId);
  }
}

async function getTargetChannel() {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.get(NEW_CHANNEL_ID);
    if (channel) return channel;
  }
  return null;
}

async function sendPost(post, extra = {}) {
  const channel = client.channels.cache.get(NEW_CHANNEL_ID) || await getTargetChannel();
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Канал ${NEW_CHANNEL_ID} не найден или не поддерживает сообщения.`);
  }

  const embed = baseEmbed()
    .setTitle(`🆕 ${post.title}`)
    .setDescription(post.content)
    .setFooter({ text: `Опубликовано разработчиком • ${post.authorTag}` });

  const sent = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });

  // Пинг роли отдельным сообщением (не внутри эмбеда), чтобы уведомление сработало.
  await channel.send({
    content: `<@&${NEW_PING_ROLE_ID}>`,
    allowedMentions: { roles: [NEW_PING_ROLE_ID] },
  }).catch(error => console.error('Не удалось пингнуть роль публикации:', error.message));

  return sent;
}

async function processScheduledPosts() {
  if (!client?.isReady()) return;
  const now = Date.now();
  const due = posts.filter(post => post.status === 'scheduled' && post.sendAt <= now);
  if (!due.length) return;

  for (const post of due) {
    try {
      await sendPost(post);
      post.status = 'sent';
      post.sentAt = Date.now();
      console.log(`✅ Запланированная публикация #${post.id} отправлена.`);
    } catch (error) {
      post.attempts = (post.attempts || 0) + 1;
      post.lastError = error.message;
      post.lastAttemptAt = Date.now();
      console.error(`❌ Не удалось отправить публикацию #${post.id}:`, error.message);
    }
  }

  // Храним историю последних 100 публикаций, чтобы файл не рос бесконечно.
  posts = posts
    .filter(post => post.status !== 'sent' || post.sentAt > Date.now() - 30 * 24 * 60 * 60 * 1000)
    .slice(-100);
  savePosts();
}

async function handleCommand(message) {
  if (!message.guild || message.author.bot) return false;
  const body = config.stripPrefix(message.content);
  if (body === null) return false;

  const args = body.trim().split(/\s+/);
  const command = (args.shift() || '').toLowerCase();
  if (!['new', 'новое'].includes(command)) return false;

  if (!canUseNewCommand(message.member)) {
    await message.reply('❌ У вас нет роли для использования `!new`.').catch(() => {});
    return true;
  }


  cleanExpiredDrafts();
  drafts.delete(message.author.id);

  const sent = await message.channel.send(buildPanel()).catch(() => null);
  if (!sent) return true;
  await message.delete().catch(() => {});
  return true;
}

function createModal() {
  const modal = new ModalBuilder()
    .setCustomId('newpost_modal_create')
    .setTitle('🆕 Новая публикация');

  const title = new TextInputBuilder()
    .setCustomId('newpost_title')
    .setLabel('Заголовок')
    .setPlaceholder('Например: Обновление сервера')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(MAX_TITLE_LENGTH)
    .setRequired(true);

  const content = new TextInputBuilder()
    .setCustomId('newpost_content')
    .setLabel('Текст публикации')
    .setPlaceholder('Напиши текст новости или объявления...')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_CONTENT_LENGTH)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(content),
  );
  return modal;
}

function createScheduleModal() {
  const modal = new ModalBuilder()
    .setCustomId('newpost_modal_schedule')
    .setTitle('🕐 Время публикации');

  const date = new TextInputBuilder()
    .setCustomId('newpost_date')
    .setLabel('Дата')
    .setPlaceholder('10.09.2026 или 2026-09-10')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(10)
    .setRequired(true);

  const time = new TextInputBuilder()
    .setCustomId('newpost_time')
    .setLabel('Время по МСК')
    .setPlaceholder('18:30')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(5)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(date),
    new ActionRowBuilder().addComponents(time),
  );
  return modal;
}

async function handleInteraction(interaction) {
  if (!interaction.guild || !interaction.isButton() && !interaction.isModalSubmit()) return false;
  if (!interaction.customId.startsWith('newpost_')) return false;

  if (!canUseNewCommand(interaction.member)) {
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Только разработчики могут управлять публикациями.', ephemeral: true }).catch(() => {});
    return true;
  }


  cleanExpiredDrafts();

  if (interaction.isButton()) {
    if (interaction.customId === 'newpost_create') {
      await interaction.showModal(createModal());
      return true;
    }

    const draft = drafts.get(interaction.user.id);
    if (!draft) {
      await interaction.reply({ content: '⚠️ Черновик устарел. Нажми `!new` и создай публикацию заново.', ephemeral: true }).catch(() => {});
      return true;
    }

    if (interaction.customId === 'newpost_cancel') {
      drafts.delete(interaction.user.id);
      await interaction.update({
        embeds: [baseEmbed().setTitle('❌ Создание отменено').setDescription('Черновик публикации удалён.')],
        components: [],
      }).catch(() => {});
      return true;
    }

    if (interaction.customId === 'newpost_send') {
      try {
        const post = {
          id: `now-${Date.now()}-${interaction.user.id}`,
          title: draft.title,
          content: draft.content,
          authorId: draft.authorId,
          authorTag: draft.authorTag,
          status: 'sent',
          createdAt: Date.now(),
          sentAt: Date.now(),
        };
        await sendPost(post);
        drafts.delete(interaction.user.id);
        await interaction.update({
          embeds: [baseEmbed().setColor(0x57f287).setTitle('✅ Публикация отправлена').setDescription(`Публикация успешно отправлена в <#${NEW_CHANNEL_ID}>.`)],
          components: [],
        }).catch(() => {});
      } catch (error) {
        await interaction.reply({ content: `❌ Не удалось отправить публикацию: ${error.message}`, ephemeral: true }).catch(() => {});
      }
      return true;
    }

    if (interaction.customId === 'newpost_schedule') {
      await interaction.showModal(createScheduleModal());
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'newpost_modal_create') {
      const title = interaction.fields.getTextInputValue('newpost_title').trim();
      const content = interaction.fields.getTextInputValue('newpost_content').trim();
      if (!title || !content) {
        await interaction.reply({ content: '❌ Заголовок и текст не могут быть пустыми.', ephemeral: true });
        return true;
      }

      drafts.set(interaction.user.id, {
        title,
        content,
        authorId: interaction.user.id,
        authorTag: interaction.user.tag,
        createdAt: Date.now(),
      });

      await interaction.reply({ ...buildPreview(drafts.get(interaction.user.id)), ephemeral: true });
      return true;
    }

    if (interaction.customId === 'newpost_modal_schedule') {
      const draft = drafts.get(interaction.user.id);
      if (!draft) {
        await interaction.reply({ content: '⚠️ Черновик устарел. Нажми `!new` и создай публикацию заново.', ephemeral: true });
        return true;
      }

      const date = interaction.fields.getTextInputValue('newpost_date').trim();
      const time = interaction.fields.getTextInputValue('newpost_time').trim();
      const sendAt = parseDateTime(`${date} ${time}`);

      if (!sendAt) {
        await interaction.reply({ content: '❌ Неверная дата или время. Используй, например: `10.09.2026` и `18:30`.', ephemeral: true });
        return true;
      }
      if (sendAt <= Date.now() + 10_000) {
        await interaction.reply({ content: '❌ Время публикации должно быть минимум через 10 секунд.', ephemeral: true });
        return true;
      }

      const post = {
        id: `${Date.now()}-${interaction.user.id}`,
        title: draft.title,
        content: draft.content,
        authorId: draft.authorId,
        authorTag: draft.authorTag,
        status: 'scheduled',
        createdAt: Date.now(),
        sendAt,
        attempts: 0,
      };
      posts.push(post);
      savePosts();
      drafts.delete(interaction.user.id);

      await interaction.reply({
        embeds: [baseEmbed().setColor(0x57f287).setTitle('🕐 Публикация запланирована')
          .setDescription(`Публикация **${post.title}** будет отправлена в <#${NEW_CHANNEL_ID}>.`)
          .addFields(
            { name: '📅 Время', value: formatScheduled(sendAt), inline: true },
            { name: '👨‍💻 Автор', value: `<@${post.authorId}>`, inline: true },
          )],
        ephemeral: true,
      });
      return true;
    }
  }

  return true;
}

function init(discordClient, botConfig) {
  client = discordClient;
  config = botConfig;
  posts = loadPosts();

  if (timer) clearInterval(timer);
  timer = setInterval(() => processScheduledPosts().catch(error => console.error('Ошибка планировщика публикаций:', error)), CHECK_INTERVAL_MS);
  processScheduledPosts().catch(error => console.error('Ошибка запуска планировщика публикаций:', error));

  client.on('messageCreate', message => {
    handleCommand(message).catch(error => console.error('Ошибка !new:', error));
  });
  client.on('interactionCreate', interaction => {
    handleInteraction(interaction).catch(error => console.error('Ошибка публикации:', error));
  });

  console.log(`✅ Система !new загружена. Канал публикаций: ${NEW_CHANNEL_ID}`);
}

module.exports = { init, NEW_CHANNEL_ID };
