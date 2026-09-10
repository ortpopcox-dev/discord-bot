// ─── Система тикетов ──────────────────────────────────────────────────────────
// Команды:
//   !тикет-меню  — отправить сообщение с кнопками (мод)
// Добавь в config.js:
//   TICKET_SUPPORT_ROLE_ID: 'ID роли которая видит тикеты'

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'tickets.json');
let tickets  = {};
let _client  = null;
let _config  = null;

function load() { if (fs.existsSync(DB_FILE)) { try { tickets = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { tickets = {}; } } }
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(tickets, null, 2)); }
function emb(color, title, desc) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (desc) e.setDescription(desc);
  return e;
}

const CATEGORIES = {
  ticket_question: { label: '❓ Вопрос',  color: 0x5865f2, emoji: '❓' },
  ticket_help:     { label: '🤝 Помощь',  color: 0x57f287, emoji: '🤝' },
  ticket_report:   { label: '🚨 Жалоба', color: 0xed4245, emoji: '🚨' },
};

function init(client, config) {
  _client = client;
  _config = config;
  load();

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // ── Создать тикет ────────────────────────────────────────────────────────
    const cat = CATEGORIES[interaction.customId];
    if (cat) {
      await interaction.deferReply({ ephemeral: true });

      // Проверить нет ли уже открытого тикета
      const existing = Object.values(tickets).find(
        t => t.userId === interaction.user.id &&
             t.guildId === interaction.guild.id &&
             t.status === 'open'
      );
      if (existing) {
        const ch = interaction.guild.channels.cache.get(existing.channelId);
        return interaction.editReply(`❌ У тебя уже есть открытый тикет: ${ch ? `<#${existing.channelId}>` : `#${existing.channelId}`}`);
      }

      // Создать канал
      const num = Object.keys(tickets).length + 1;
      const channelName = `тикет-${interaction.user.username}-${num}`;

      const overwrites = [
        {
          id: interaction.guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ];

      // Добавить доступ для роли поддержки
      if (_config.TICKET_SUPPORT_ROLE_ID) {
        overwrites.push({
          id: _config.TICKET_SUPPORT_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        });
      }

      // Добавить доступ для ролей модераторов
      const modRoles = _config.TICKET_MOD_ROLE_IDS;
      for (const roleId of modRoles) {
        overwrites.push({
          id: roleId,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        });
      }

      let channel;
      try {
        channel = await interaction.guild.channels.create({
          name: channelName,
          permissionOverwrites: overwrites,
        });
      } catch(e) {
        return interaction.editReply('❌ Не могу создать канал — проверь права бота!');
      }

      // Сохранить тикет
      const id = num;
      tickets[id] = {
        id,
        guildId:   interaction.guild.id,
        userId:    interaction.user.id,
        userTag:   interaction.user.tag,
        category:  cat.label,
        channelId: channel.id,
        status:    'open',
        timestamp: Date.now(),
      };
      save();

      // Отправить приветствие в канал тикета
      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`close_ticket_${id}`)
          .setLabel('🔒 Закрыть тикет')
          .setStyle(ButtonStyle.Danger)
      );

      const welcome = emb(cat.color, `${cat.label} — Тикет #${id}`,
        `Привет, <@${interaction.user.id}>! 👋\nТвой тикет создан. Опиши свою проблему и модераторы помогут тебе.\n\nЧтобы закрыть тикет — нажми кнопку ниже.`
      ).addFields(
        { name: '👤 Пользователь', value: `<@${interaction.user.id}>`, inline: true },
        { name: '📂 Категория', value: cat.label, inline: true },
      );

      await channel.send({
        content: `<@${interaction.user.id}>`,
        embeds: [welcome],
        components: [closeRow],
      });

      await interaction.editReply(`✅ Тикет создан: <#${channel.id}>`);
      return;
    }

    // ── Закрыть тикет ────────────────────────────────────────────────────────
    if (interaction.customId.startsWith('close_ticket_')) {
      const id = parseInt(interaction.customId.replace('close_ticket_', ''));
      const ticket = tickets[id];
      if (!ticket) return interaction.reply({ content: '❌ Тикет не найден', ephemeral: true });

      // Только создатель тикета или модератор могут закрыть
      const isOwner = interaction.user.id === ticket.userId;
      const isMod   = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
                      _config.TICKET_MOD_ROLE_IDS.some(r => interaction.member.roles.cache.has(r));

      if (!isOwner && !isMod) {
        return interaction.reply({ content: '❌ Только создатель тикета или модератор могут закрыть его', ephemeral: true });
      }

      await interaction.reply({ content: '🔒 Закрываю тикет...', ephemeral: true });

      ticket.status     = 'closed';
      ticket.closedBy   = interaction.user.tag;
      ticket.closedAt   = Date.now();
      save();

      // Удалить канал через 5 секунд
      await interaction.channel.send({ embeds: [
        emb(0xed4245, '🔒 Тикет закрыт',
          `Тикет закрыт пользователем <@${interaction.user.id}>.\nКанал будет удалён через 5 секунд.`
        )
      ]});

      setTimeout(() => {
        interaction.channel.delete().catch(() => {});
      }, 5000);
    }
  });

  console.log('✅ Система тикетов загружена');
}

// ── !тикет-меню ───────────────────────────────────────────────────────────────
async function handleMenu(message) {
  const e = emb(0x5865f2, '🎫 Создать тикет',
    'Нужна помощь или есть вопрос? Создай тикет и модераторы помогут тебе!\n\n' +
    '❓ **Вопрос** — задать вопрос администрации\n' +
    '🤝 **Помощь** — нужна помощь на сервере\n' +
    '🚨 **Жалоба** — пожаловаться на участника\n\n' +
    '**Нажми кнопку ниже чтобы создать тикет!**'
  ).setFooter({ text: 'Создаётся приватный канал только для тебя и модераторов' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_question').setLabel('❓ Вопрос').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket_help').setLabel('🤝 Помощь').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket_report').setLabel('🚨 Жалоба').setStyle(ButtonStyle.Danger),
  );

  await message.channel.send({ embeds: [e], components: [row] });
  await message.delete().catch(() => {});
}

module.exports = { init, handleMenu };
