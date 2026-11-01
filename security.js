const {
  AuditLogEvent,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  PermissionFlagsBits,
} = require("discord.js");

const name = "Security";
const description = "Anti-spam, anti-nuke monitoring, and Discord AutoMod setup.";

const config = {
  spam: {
    enabled: true,
    windowMs: 7000,
    maxMessages: 6,
    duplicateLimit: 4,
    timeoutMs: 60_000,
  },
  antiNuke: {
    enabled: true,
    windowMs: 15_000,
    threshold: 3,
    actions: [
      AuditLogEvent.ChannelDelete,
      AuditLogEvent.RoleDelete,
      AuditLogEvent.MemberBanAdd,
      AuditLogEvent.WebhookCreate,
      AuditLogEvent.BotAdd,
    ],
    removeDangerousRoles: false,
  },
};

const messageBuckets = new Map();
const auditBuckets = new Map();
const snapshots = new Map();
const recentAuditEntries = new Set();

function now() {
  return Date.now();
}

function trimBucket(bucket, cutoff) {
  while (bucket.length && bucket[0].time < cutoff) bucket.shift();
}

function logChannelFor(guild, configuredId) {
  if (configuredId) return guild.channels.cache.get(configuredId) || null;
  return null;
}

async function sendLog(guild, message, configuredId) {
  const channel = logChannelFor(guild, configuredId || process.env.SECURITY_LOG_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !channel.send) return;
  await channel.send({ content: message }).catch(() => {});
}

function normalizeContent(content) {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

async function handleMessage(message, settings = config) {
  if (!settings.spam.enabled || !message.guild || message.author.bot) return;
  if (!message.member || message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const bucket = messageBuckets.get(key) || [];
  const time = now();
  trimBucket(bucket, time - settings.spam.windowMs);
  bucket.push({ time, content: normalizeContent(message.content || "") });
  messageBuckets.set(key, bucket);

  const repeated = bucket.filter((entry) => entry.content && entry.content === normalizeContent(message.content || "")).length;
  if (bucket.length < settings.spam.maxMessages && repeated < settings.spam.duplicateLimit) return;

  await message.member.timeout(settings.spam.timeoutMs, "Automatic anti-spam protection").catch(() => {});
  await message.delete().catch(() => {});
  await sendLog(message.guild, `Anti-spam: timed out ${message.author.tag} in #${message.channel.name}.`);
  messageBuckets.delete(key);
}

async function captureGuildSnapshot(guild) {
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  snapshots.set(guild.id, {
    channels: guild.channels.cache.map((channel) => ({
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      topic: channel.topic || null,
      nsfw: Boolean(channel.nsfw),
      position: channel.rawPosition,
      permissionOverwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      })),
    })),
    roles: guild.roles.cache.filter((role) => role.id !== guild.id).map((role) => ({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
    })),
    capturedAt: now(),
  });
}

async function inspectAuditLog(guild, auditType, settings = config) {
  if (!settings.antiNuke.enabled) return;
  const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 }).catch(() => null);
  const entry = logs?.entries.first();
  if (!entry || now() - entry.createdTimestamp > 20_000) return;

  const uniqueKey = `${guild.id}:${entry.id}`;
  if (recentAuditEntries.has(uniqueKey)) return;
  recentAuditEntries.add(uniqueKey);
  setTimeout(() => recentAuditEntries.delete(uniqueKey), 30_000);

  const executor = entry.executor;
  if (!executor || executor.bot || executor.id === guild.ownerId) return;

  const key = `${guild.id}:${executor.id}`;
  const bucket = auditBuckets.get(key) || [];
  trimBucket(bucket, now() - settings.antiNuke.windowMs);
  bucket.push({ time: now(), type: auditType });
  auditBuckets.set(key, bucket);

  if (bucket.length < settings.antiNuke.threshold) return;

  await sendLog(
    guild,
    `Anti-nuke alert: ${executor.tag || executor.username} triggered ${bucket.length} sensitive actions within ${settings.antiNuke.windowMs / 1000}s. Review the audit log immediately.`
  );

  if (settings.antiNuke.removeDangerousRoles) {
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (member?.manageable) {
      const dangerous = member.roles.cache.filter((role) =>
        role.permissions.has([
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.ManageGuild,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.BanMembers,
        ])
      );
      if (dangerous.size) await member.roles.remove(dangerous, "Anti-nuke threshold exceeded").catch(() => {});
    }
  }
  auditBuckets.delete(key);
}

async function installAutoMod(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error("The bot needs Manage Server permission to install AutoMod rules.");
  }

  const existing = await guild.autoModerationRules.fetch().catch(() => null);
  const rules = [
    {
      name: "Claw Utils - Block common slurs",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: 1,
      triggerMetadata: { presets: [AutoModerationRuleKeywordPresetType.Slurs] },
      actions: [{ type: AutoModerationActionType.BlockMessage }],
      enabled: true,
      exemptRoles: [],
      exemptChannels: [],
    },
    {
      name: "Claw Utils - Mention spam",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: 5,
      triggerMetadata: { mentionTotalLimit: 5, mentionRaidProtectionEnabled: true },
      actions: [{ type: AutoModerationActionType.BlockMessage }],
      enabled: true,
      exemptRoles: [],
      exemptChannels: [],
    },
  ];

  const created = [];
  for (const rule of rules) {
    if (existing?.some((item) => item.name === rule.name)) continue;
    created.push(await guild.autoModerationRules.create(rule).catch((error) => {
      throw new Error(`Could not create AutoMod rule "${rule.name}": ${error.message}`);
    }));
  }
  return created;
}

async function initialize(client, options = {}) {
  const settings = { ...config, ...options };
  client.on("messageCreate", (message) => handleMessage(message, settings));

  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    if (!settings.antiNuke.actions.includes(entry.action)) return;
    await inspectAuditLog(guild, entry.action, settings);
  });

  client.on("guildCreate", async (guild) => {
    await captureGuildSnapshot(guild);
  });

  for (const guild of client.guilds.cache.values()) {
    await captureGuildSnapshot(guild);
  }
}

async function execute(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== "security") return false;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need Manage Server permission to use this command.", ephemeral: true });
    return true;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "automod") {
    const rules = await installAutoMod(interaction.guild);
    await interaction.reply({
      content: rules.length ? `Installed ${rules.length} AutoMod rule(s).` : "The Claw Utils AutoMod rules are already installed.",
      ephemeral: true,
    });
  } else if (subcommand === "snapshot") {
    await captureGuildSnapshot(interaction.guild);
    await interaction.reply({ content: "The server structure snapshot has been refreshed.", ephemeral: true });
  } else {
    await interaction.reply({ content: "Unknown security subcommand.", ephemeral: true });
  }
  return true;
}

module.exports = {
  name,
  description,
  config,
  initialize,
  execute,
  captureGuildSnapshot,
  installAutoMod,
};
