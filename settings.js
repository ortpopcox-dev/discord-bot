const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

let settings = {
  maintenance: false,
  disabledCommands: [],
  rolePermissions: {},
  userPermissions: {},
  channelOverrides: {},
  logs: {
    deleted: null,
    edited: null,
    money: null,
  },
};

function load() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch (error) {
      console.error('Не удалось прочитать settings.json:', error.message);
    }
  }
  settings.disabledCommands = Array.isArray(settings.disabledCommands) ? settings.disabledCommands : [];
  settings.rolePermissions = settings.rolePermissions || {};
  settings.userPermissions = settings.userPermissions || {};
  settings.channelOverrides = settings.channelOverrides || {};
  settings.logs = { deleted: null, edited: null, money: null, ...(settings.logs || {}) };
  save();
}

function save() {
  const temp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2));
  fs.renameSync(temp, SETTINGS_FILE);
}

function normalize(command) {
  return String(command || '').trim().toLowerCase().replace(/^!/, '');
}

function isDeveloper(member, userId, config) {
  const ids = config?.DEVELOPER_USER_IDS || [];
  const roles = config?.DEVELOPER_ROLE_IDS || [];
  return Boolean(
    ids.includes(userId) ||
    member?.permissions?.has?.('Administrator') ||
    member?.roles?.cache?.some?.(role => roles.includes(role.id)),
  );
}

function canManageSettings(member, config) {
  return Boolean(
    isDeveloper(member, member?.id, config) ||
    member?.permissions?.has?.('Administrator') ||
    member?.permissions?.has?.('ManageGuild') ||
    (config?.ADMIN_ROLE_ID && member?.roles?.cache?.has?.(config.ADMIN_ROLE_ID)),
  );
}

function isAllowed(message, command, config) {
  const name = normalize(command);
  if (!name || isDeveloper(message.member, message.author?.id, config)) return true;

  const channel = settings.channelOverrides[message.channel?.id];
  if (channel?.deny?.includes(name)) return false;
  if (channel?.allow?.includes(name)) return true;
  if (settings.disabledCommands.includes(name)) return false;

  const roleIds = message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : [];
  for (const roleId of roleIds) {
    const permissions = settings.rolePermissions[roleId];
    if (permissions?.deny?.includes(name)) return false;
  }
  if (message.author?.id && settings.userPermissions[message.author.id]?.deny?.includes(name)) return false;
  for (const roleId of roleIds) {
    const permissions = settings.rolePermissions[roleId];
    if (permissions?.allow?.includes(name)) return true;
  }
  if (message.author?.id && settings.userPermissions[message.author.id]?.allow?.includes(name)) return true;
  return true;
}

function addPermission(collection, id, type, command) {
  if (!collection[id]) collection[id] = { allow: [], deny: [] };
  collection[id].allow = Array.isArray(collection[id].allow) ? collection[id].allow : [];
  collection[id].deny = Array.isArray(collection[id].deny) ? collection[id].deny : [];
  collection[id][type] = [...new Set([...collection[id][type], normalize(command)])];
  collection[id][type === 'allow' ? 'deny' : 'allow'] =
    collection[id][type === 'allow' ? 'deny' : 'allow'].filter(item => item !== normalize(command));
  save();
}

function removePermission(collection, id, type, command) {
  if (!collection[id]) return;
  collection[id][type] = (collection[id][type] || []).filter(item => item !== normalize(command));
  if (!collection[id].allow.length && !collection[id].deny.length) delete collection[id];
  save();
}

function clearPermission(collection, id) {
  delete collection[id];
  save();
}

function setGlobalCommand(command, enabled) {
  const name = normalize(command);
  settings.disabledCommands = enabled
    ? settings.disabledCommands.filter(item => item !== name)
    : [...new Set([...settings.disabledCommands, name])];
  save();
}

function setChannelOverride(channelId, command, type) {
  if (!settings.channelOverrides[channelId]) settings.channelOverrides[channelId] = { allow: [], deny: [] };
  const channel = settings.channelOverrides[channelId];
  channel[type] = [...new Set([...(channel[type] || []), normalize(command)])];
  channel[type === 'allow' ? 'deny' : 'allow'] =
    (channel[type === 'allow' ? 'deny' : 'allow'] || []).filter(item => item !== normalize(command));
  save();
}

function get() {
  return settings;
}

function setMaintenance(value) {
  settings.maintenance = Boolean(value);
  save();
}

function setLog(type, channelId) {
  if (Object.prototype.hasOwnProperty.call(settings.logs, type)) {
    settings.logs[type] = channelId;
    save();
  }
}

module.exports = {
  load,
  save,
  get,
  isDeveloper,
  canManageSettings,
  isAllowed,
  addPermission,
  removePermission,
  clearPermission,
  setGlobalCommand,
  setChannelOverride,
  setMaintenance,
  setLog,
};