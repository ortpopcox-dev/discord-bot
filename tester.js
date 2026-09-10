// ─── Система заявок ──────────────────────────────────────────────────────────
// Команды:
//   !заявки-меню          — отправить сообщение с кнопками выбора должности
//   !заявки [filter]      — список заявок (pending/accepted/rejected/reviewing/all)
//
// config.js:
//   APP_CHANNEL_ID     — канал, куда падают новые заявки
//   MOD_APP_ROLE_ID    — роль модератора (выдаётся при accept)
//   EVENT_APP_ROLE_ID  — роль ивент-модера (выдаётся при accept)

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
} = require('discord.js');

const fs = require('fs');
const path = require('path');

const store = require('./store');

const KEY = 'apps';
let apps = {};
let _client = null;
let _config = null;

// ─── Роли ────────────────────────────────────────────────────────────────────
// Заполняются через REVIEW_ROLE_IDS в переменных окружения.
let REVIEW_ROLES = [];

// ─── Должности ───────────────────────────────────────────────────────────────
// Важно: максимум 5 полей в модалке Discord.
const POSITIONS = {
  mod: {
    label: '🛡️ Модератор',
    color: 0x5865f2,
    roleConfigKey: 'MOD_APP_ROLE_ID',
    questions: [
      { id: 'age',      label: 'Сколько тебе лет?',              style: 'short',     max: 100,  required: true },
      { id: 'exp',      label: 'Есть ли опыт модерации?',        style: 'paragraph', max: 1000, required: true },
      { id: 'time',     label: 'Сколько времени готов уделять?', style: 'short',     max: 200,  required: true },
      { id: 'why',      label: 'Почему именно ты?',              style: 'paragraph', max: 1000, required: true },
      { id: 'conflict', label: 'Как решишь конфликт двух игроков?', style: 'paragraph', max: 1000, required: true },
    ],
  },
  event: {
    label: '🎉 Ивент-модер',
    color: 0xfee75c,
    roleConfigKey: 'EVENT_APP_ROLE_ID',
    questions: [
      { id: 'age',   label: 'Сколько тебе лет?',              style: 'short',     max: 100,  required: true },
      { id: 'ideas', label: 'Какие идеи ивентов есть?',       style: 'paragraph', max: 1000, required: true },
      { id: 'time',  label: 'Сколько времени готов уделять?', style: 'short',     max: 200,  required: true },
      { id: 'why',   label: 'Почему именно ты?',              style: 'paragraph', max: 1000, required: true },
    ],
  },
};

// ─── Utils ───────────────────────────────────────────────────────────────────
function load() {
  const loaded = store.read(KEY, null);
  apps = (loaded && typeof loaded === 'object') ? loaded : {};
}
function save() {
  store.write(KEY, apps);
}
function nextId() {
  const ids = Object.keys(apps).map(Number);
  return ids.length ? Math.max(...ids) + 1 : 1;
}
function emb(color, title, desc) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (desc) e.setDescription(desc);
  return e;
}
function canReview(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
         REVIEW_ROLES.some(r => member.roles.cache.has(r));
}

// ─── Embed заявки в канале ревью ─────────────────────────────────────────────
function buildAppEmbed(app) {
  const pos = POSITIONS[app.posKey];
  const color = pos ? pos.color : 0x5865f2;
  const statusMap = {
    pending:   '⏳ Ожидает',
    reviewing: '👀 На рассмотрении',
    accepted:  '✅ Принята',
    rejected:  '❌ Отклонена',
  };

  const e = emb(color, `Заявка #${app.id} — ${app.posLabel}`, null)
    .addFields(
      { name: 'Кандидат', value: `<@${app.userId}> (\`${app.userTag}\`)`, inline: true },
      { name: 'Статус',   value: statusMap[app.status] || app.status,     inline: true },
      { name: 'Подана',   value: `<t:${Math.floor(app.timestamp / 1000)}:R>`, inline: true },
    );

  if (pos) {
    for (const q of pos.questions) {
      const val = app.answers?.[q.id] || '—';
      e.addFields({ name: q.label, value: String(val).slice(0, 1024) });
    }
  }

  if (app.reviewerTag) e.setFooter({ text: `Рассматривает: ${app.reviewerTag}` });
  return e;
}

function buildReviewButtons(id, status) {
  const row = new ActionRowBuilder();

  if (status === 'pending') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`app_review_${id}`).setLabel('👀 Взять').setStyle(ButtonStyle.Primary),
    );
  }
  if (status === 'pending' || status === 'reviewing') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`app_accept_${id}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`app_reject_${id}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
    );
  }

  return row.components.length ? row : null;
}

async function updateReviewMessage(app) {
  if (!app.messageId || !_config.APP_CHANNEL_ID) return;
  try {
    const channel = await _client.channels.fetch(_config.APP_CHANNEL_ID);
    const msg = await channel.messages.fetch(app.messageId);
    const e = buildAppEmbed(app);
    const row = buildReviewButtons(app.id, app.status);
    await msg.edit({ embeds: [e], components: row ? [row] : [] });
  } catch (e) {
    console.error('⚠️ Не удалось обновить сообщение заявки:', e.message);
  }
}

function scheduleChannelDeletion(guild, channelId, delayMs = 10 * 60 * 1000) {
  if (!channelId) return;
  setTimeout(async () => {
    try {
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (ch) await ch.delete().catch(() => {});
    } catch {}
  }, delayMs);
}

// ─── Init ────────────────────────────────────────────────────────────────────
function init(client, config) {
  _client = client;
  _config = config;
  REVIEW_ROLES = config.REVIEW_ROLE_IDS;
  load();

  client.on('interactionCreate', async (interaction) => {
    try {
      // ─── КНОПКА «Подать заявку на должность» ─────────────────────────
      if (interaction.isButton() && interaction.customId.startsWith('app_apply_')) {
        const posKey = interaction.customId.replace('app_apply_', '');
        const pos = POSITIONS[posKey];
        if (!pos) {
          return interaction.reply({ content: '❌ Неизвестная должность', ephemeral: true });
        }

        // Проверка: нет ли уже активной заявки на ту же должность
        const existing = Object.values(apps).find(
          a => a.userId === interaction.user.id &&
               a.guildId === interaction.guild.id &&
               a.posKey === posKey &&
               (a.status === 'pending' || a.status === 'reviewing')
        );
        if (existing) {
          return interaction.reply({
            content: `❌ У тебя уже есть активная заявка #${existing.id} на эту должность`,
            ephemeral: true,
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`app_modal_${posKey}`)
          .setTitle(`Заявка: ${pos.label}`.slice(0, 45));

        for (const q of pos.questions) {
          const input = new TextInputBuilder()
            .setCustomId(q.id)
            .setLabel(q.label.slice(0, 45))
            .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(q.required)
            .setMaxLength(q.max);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
        }

        return interaction.showModal(modal);
      }

      // ─── ОТПРАВКА МОДАЛКИ ────────────────────────────────────────────
      if (interaction.isModalSubmit() && interaction.customId.startsWith('app_modal_')) {
        const posKey = interaction.customId.replace('app_modal_', '');
        const pos = POSITIONS[posKey];
        if (!pos) return;

        await interaction.deferReply({ ephemeral: true });

        const answers = {};
        for (const q of pos.questions) {
          answers[q.id] = interaction.fields.getTextInputValue(q.id);
        }

        const id = nextId();
        const app = {
          id,
          guildId:  interaction.guild.id,
          userId:   interaction.user.id,
          userTag:  interaction.user.tag,
          posKey,
          posLabel: pos.label,
          answers,
          status:   'pending',
          timestamp: Date.now(),
        };
        apps[id] = app;
        save();

        if (!_config.APP_CHANNEL_ID) {
          return interaction.editReply('❌ APP_CHANNEL_ID не настроен в config.js');
        }
        const channel = await interaction.guild.channels.fetch(_config.APP_CHANNEL_ID).catch(() => null);
        if (!channel) {
          return interaction.editReply('❌ Канал заявок не найден');
        }

        const e = buildAppEmbed(app);
        const row = buildReviewButtons(id, 'pending');
        const msg = await channel.send({ embeds: [e], components: row ? [row] : [] });

        app.messageId = msg.id;
        save();

        return interaction.editReply(`✅ Заявка #${id} отправлена на рассмотрение`);
      }

      // ─── ДАЛЬШЕ — только кнопки ─────────────────────────────────────
      if (!interaction.isButton()) return;
      const { customId } = interaction;

      // ─── ВЗЯТЬ ЗАЯВКУ ──────────────────────────────────────────────
      if (customId.startsWith('app_review_')) {
        const id = parseInt(customId.replace('app_review_', ''));
        const app = apps[id];
        if (!app) return interaction.reply({ content: '❌ Заявка не найдена', ephemeral: true });
        if (!canReview(interaction.member))
          return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        if (app.status !== 'pending')
          return interaction.reply({ content: '❌ Заявка уже в работе', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const overwrites = [
          { id: interaction.guild.id, deny:  [PermissionsBitField.Flags.ViewChannel] },
          { id: _client.user.id,      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: interaction.user.id,  allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: app.userId,           allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ];
        for (const r of REVIEW_ROLES) {
          if (!interaction.guild.roles.cache.has(r)) continue;
          overwrites.push({
            id: r,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
          });
        }

        let channel;
        try {
          channel = await interaction.guild.channels.create({
            name: `заявка-${id}`,
            permissionOverwrites: overwrites,
          });
        } catch (e) {
          console.error('❌ Ошибка создания канала:', e);
          return interaction.editReply('❌ Ошибка создания канала');
        }

        app.status = 'reviewing';
        app.reviewChannelId = channel.id;
        app.reviewerId = interaction.user.id;
        app.reviewerTag = interaction.user.tag;
        save();

        const welcome = emb(0x5865f2, `👀 Рассмотрение заявки #${id}`,
          `Кандидат: <@${app.userId}>\nРассматривает: <@${interaction.user.id}>\n\nЗдесь можно задать кандидату уточняющие вопросы. Решение принимается кнопками в канале <#${_config.APP_CHANNEL_ID}>.`
        );
        await channel.send({ content: `<@${app.userId}>`, embeds: [welcome] });

        await updateReviewMessage(app);
        return interaction.editReply(`✅ Канал создан: <#${channel.id}>`);
      }

      // ─── ПРИНЯТЬ ───────────────────────────────────────────────────
      if (customId.startsWith('app_accept_')) {
        const id = parseInt(customId.replace('app_accept_', ''));
        const app = apps[id];
        if (!app) return interaction.reply({ content: '❌ Заявка не найдена', ephemeral: true });
        if (!canReview(interaction.member))
          return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        if (app.status === 'accepted' || app.status === 'rejected')
          return interaction.reply({ content: '❌ Заявка уже закрыта', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        app.status = 'accepted';
        app.reviewedBy = interaction.user.tag;
        save();

        // Выдать роль
        const pos = POSITIONS[app.posKey];
        const roleId = pos && _config[pos.roleConfigKey];
        let roleResult = '';
        if (roleId) {
          try {
            const target = await interaction.guild.members.fetch(app.userId);
            await target.roles.add(roleId, `Принята заявка #${id}`);
            roleResult = `\n✅ Роль <@&${roleId}> выдана`;
          } catch (e) {
            console.error('❌ Не удалось выдать роль:', e);
            roleResult = `\n⚠️ Не удалось выдать роль: ${e.message}`;
          }
        }

        // Уведомление в ЛС
        try {
          const user = await _client.users.fetch(app.userId);
          await user.send({ embeds: [
            emb(0x57f287, `✅ Заявка #${id} принята`,
              `Твоя заявка на должность **${app.posLabel}** принята.`)
          ]});
        } catch {}

        await updateReviewMessage(app);

        if (app.reviewChannelId) {
          const ch = await interaction.guild.channels.fetch(app.reviewChannelId).catch(() => null);
          if (ch) {
            await ch.send({ embeds: [
              emb(0x57f287, '✅ Заявка принята',
                `Заявка принята <@${interaction.user.id}>.\nКанал будет удалён через 10 минут.`)
            ]}).catch(() => {});
            scheduleChannelDeletion(interaction.guild, app.reviewChannelId);
          }
        }

        return interaction.editReply(`✅ Заявка #${id} принята${roleResult}`);
      }

      // ─── ОТКЛОНИТЬ ────────────────────────────────────────────────
      if (customId.startsWith('app_reject_')) {
        const id = parseInt(customId.replace('app_reject_', ''));
        const app = apps[id];
        if (!app) return interaction.reply({ content: '❌ Заявка не найдена', ephemeral: true });
        if (!canReview(interaction.member))
          return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        if (app.status === 'accepted' || app.status === 'rejected')
          return interaction.reply({ content: '❌ Заявка уже закрыта', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        app.status = 'rejected';
        app.reviewedBy = interaction.user.tag;
        save();

        try {
          const user = await _client.users.fetch(app.userId);
          await user.send({ embeds: [
            emb(0xed4245, `❌ Заявка #${id} отклонена`,
              `Твоя заявка на должность **${app.posLabel}** отклонена.`)
          ]});
        } catch {}

        await updateReviewMessage(app);

        if (app.reviewChannelId) {
          const ch = await interaction.guild.channels.fetch(app.reviewChannelId).catch(() => null);
          if (ch) {
            await ch.send({ embeds: [
              emb(0xed4245, '❌ Заявка отклонена',
                `Заявка отклонена <@${interaction.user.id}>.\nКанал будет удалён через 10 минут.`)
            ]}).catch(() => {});
            scheduleChannelDeletion(interaction.guild, app.reviewChannelId);
          }
        }

        return interaction.editReply(`❌ Заявка #${id} отклонена`);
      }
    } catch (err) {
      console.error('❌ Ошибка в обработчике заявок:', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: '❌ Внутренняя ошибка', ephemeral: true }).catch(() => {});
      }
    }
  });

  console.log('✅ Заявки работают');
}

// ─── !заявки-меню ────────────────────────────────────────────────────────────
async function handleMenu(message) {
  const e = emb(0x5865f2, '📝 Подача заявки на должность',
    'Выбери должность, на которую хочешь подать заявку.\n\n' +
    '🛡️ **Модератор** — следить за порядком на сервере\n' +
    '🎉 **Ивент-модер** — проводить ивенты и конкурсы\n\n' +
    '**Нажми кнопку ниже чтобы заполнить анкету.**'
  ).setFooter({ text: 'Заявка уйдёт на рассмотрение администрации' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('app_apply_mod').setLabel('🛡️ Модератор').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('app_apply_event').setLabel('🎉 Ивент-модер').setStyle(ButtonStyle.Success),
  );

  await message.channel.send({ embeds: [e], components: [row] });
  await message.delete().catch(() => {});
}

// ─── !заявки [filter] ────────────────────────────────────────────────────────
// filter: pending (по умолчанию) | reviewing | accepted | rejected | all
async function handleList(message) {
  const args = message.content.trim().split(/\s+/).slice(1);
  const filter = (args[0] || 'pending').toLowerCase();

  const valid = ['pending', 'reviewing', 'accepted', 'rejected', 'all'];
  if (!valid.includes(filter)) {
    return message.reply(`❌ Неверный фильтр. Доступно: ${valid.join(', ')}`);
  }

  const list = Object.values(apps)
    .filter(a => a.guildId === message.guild.id)
    .filter(a => filter === 'all' ? true : a.status === filter)
    .sort((a, b) => b.timestamp - a.timestamp);

  const statusIcon = {
    pending:   '⏳',
    reviewing: '👀',
    accepted:  '✅',
    rejected:  '❌',
  };

  const titleMap = {
    pending:   '⏳ Ожидающие заявки',
    reviewing: '👀 Заявки на рассмотрении',
    accepted:  '✅ Принятые заявки',
    rejected:  '❌ Отклонённые заявки',
    all:       '📋 Все заявки',
  };

  if (!list.length) {
    const e = emb(0x5865f2, titleMap[filter], 'Заявок нет.');
    return message.channel.send({ embeds: [e] });
  }

  // Берём первые 25, чтобы не упереться в лимит описания embed (4096 символов)
  const MAX = 25;
  const shown = list.slice(0, MAX);
  const lines = shown.map(a =>
    `${statusIcon[a.status] || '•'} **#${a.id}** — ${a.posLabel} — <@${a.userId}> — <t:${Math.floor(a.timestamp/1000)}:R>`
  );

  let desc = lines.join('\n');
  if (list.length > MAX) {
    desc += `\n\n*…и ещё ${list.length - MAX}. Используй фильтр, чтобы сузить выборку.*`;
  }

  const e = emb(0x5865f2, `${titleMap[filter]} (${list.length})`, desc)
    .setFooter({ text: `Фильтр: ${filter} · Использование: !заявки [${valid.join('|')}]` });

  await message.channel.send({ embeds: [e] });
}

module.exports = { init, handleMenu, handleList };
