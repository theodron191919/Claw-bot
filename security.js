const {
  AuditLogEvent,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  PermissionFlagsBits,
} = require("discord.js");

const name = "Security";
const description = "Anti-spam, anti-nuke monitoring, audit logging, and Discord AutoMod.";
const SECURITY_LOG_CHANNEL_ID = "1563725011850756103";
const QUARANTINE_ROLE_NAME = "Claw Utils Quarantine";
const CHANNEL_DELETE_LIMIT = 3;
const CHANNEL_DELETE_WINDOW_MS = 15_000;
const TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const POWERFUL_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageEvents,
];

const WATCHED_ACTIONS = new Set([
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.MemberRoleUpdate,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberPrune,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookUpdate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.BotAdd,
  AuditLogEvent.GuildUpdate,
  AuditLogEvent.IntegrationCreate,
  AuditLogEvent.IntegrationUpdate,
  AuditLogEvent.IntegrationDelete,
  AuditLogEvent.MemberUpdate,
]);

const config = {
  spam: {
    enabled: true,
    windowMs: 7000,
    maxMessages: 6,
    duplicateLimit: 4,
    timeoutMs: 60_000,
  },
  antiNuke: { enabled: true },
};

const messageBuckets = new Map();
const channelDeleteBuckets = new Map();
const recentAuditEntries = new Set();
const snapshots = new Map();
const quarantineRoleLocks = new Map();

function now() {
  return Date.now();
}

function trimBucket(bucket, cutoff) {
  while (bucket.length && bucket[0].time < cutoff) bucket.shift();
}

function normalizeContent(content) {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

async function log(guild, message) {
  let channel = guild.channels.cache.get(SECURITY_LOG_CHANNEL_ID);
  if (!channel) channel = await guild.channels.fetch(SECURITY_LOG_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) {
    console.error("Claw Utils could not access the configured security log channel.");
    return;
  }
  await channel.send({ content: message }).catch((error) => {
    console.error("Claw Utils could not send a security log:", error.message);
  });
}

function isPowerfulRole(role) {
  return Boolean(role?.permissions?.has(POWERFUL_PERMISSIONS));
}

function formatActor(entry) {
  const actor = entry.executor;
  return actor ? `${actor.tag || actor.username} (${actor.id})` : "Unknown actor";
}

function formatTarget(entry) {
  const target = entry.target;
  if (!target) return "Unknown target";
  return `${target.name || target.username || "Unknown"} (${target.id || "unknown ID"})`;
}

async function getQuarantineRole(guild) {
  let role = guild.roles.cache.find((item) => item.name === QUARANTINE_ROLE_NAME);
  if (!role) {
    role = await guild.roles.create({
      name: QUARANTINE_ROLE_NAME,
      permissions: [],
      reason: "Claw Utils anti-nuke quarantine role",
    });
  }
  return role;
}

async function quarantine(guild, userId, reason, auditEntry) {
  if (!userId || userId === guild.ownerId) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot || !member.manageable) {
    await log(guild, `SECURITY ALERT — Could not quarantine <@${userId}>. Reason: ${reason}. The bot may lack role hierarchy or permissions.`);
    return false;
  }

  const existingLock = quarantineRoleLocks.get(`${guild.id}:${userId}`);
  if (existingLock) return existingLock;

  const operation = (async () => {
    try {
      const role = await getQuarantineRole(guild);
      const removableRoles = member.roles.cache.filter((item) =>
        item.id !== guild.id && item.id !== role.id && !item.managed && item.editable
      );

      if (removableRoles.size) {
        await member.roles.remove(removableRoles, `Claw Utils quarantine: ${reason}`);
      }
      await member.roles.add(role, `Claw Utils quarantine: ${reason}`);
      await member.timeout(TIMEOUT_MS, `Claw Utils quarantine: ${reason}`);

      await log(
        guild,
        `QUARANTINE APPLIED\nUser: <@${userId}> (${userId})\nReason: ${reason}\nAction: ${auditEntry?.action ?? "Unknown"}\nTarget: ${auditEntry ? formatTarget(auditEntry) : "Not available"}\nRemoved assignable roles: ${removableRoles.size}\nTimeout: 28 days`
      );
      return true;
    } catch (error) {
      await log(guild, `CRITICAL — Quarantine failed for <@${userId}>. Reason: ${reason}. Error: ${error.message}`);
      return false;
    } finally {
      quarantineRoleLocks.delete(`${guild.id}:${userId}`);
    }
  })();

  quarantineRoleLocks.set(`${guild.id}:${userId}`, operation);
  return operation;
}

async function handleMessage(message, settings = config) {
  if (!settings.spam.enabled || !message.guild || message.author.bot) return;
  if (!message.member || message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const bucket = messageBuckets.get(key) || [];
  const time = now();
  const content = normalizeContent(message.content || "");
  trimBucket(bucket, time - settings.spam.windowMs);
  bucket.push({ time, content });
  messageBuckets.set(key, bucket);

  const repeated = bucket.filter((entry) => entry.content && entry.content === content).length;
  if (bucket.length < settings.spam.maxMessages && repeated < settings.spam.duplicateLimit) return;

  await message.member.timeout(settings.spam.timeoutMs, "Automatic anti-spam protection").catch(() => {});
  await message.delete().catch(() => {});
  await log(message.guild, `ANTI-SPAM — Timed out <@${message.author.id}> in <#${message.channel.id}>.`);
  messageBuckets.delete(key);
}

async function captureGuildSnapshot(guild) {
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  snapshots.set(guild.id, {
    channels: guild.channels.cache.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      topic: channel.topic || null,
      nsfw: Boolean(channel.nsfw),
      position: channel.rawPosition,
    })),
    roles: guild.roles.cache.filter((role) => role.id !== guild.id).map((role) => ({
      id: role.id,
      name: role.name,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
    })),
    capturedAt: now(),
  });
}

function addedRoleIds(entry) {
  const addition = entry.changes?.find((change) => change.key === "$add");
  if (!Array.isArray(addition?.new)) return [];
  return addition.new.map((role) => role.id).filter(Boolean);
}

async function handleAuditEntry(entry, guild, settings = config) {
  if (!settings.antiNuke.enabled || !WATCHED_ACTIONS.has(entry.action)) return;

  const uniqueKey = `${guild.id}:${entry.id}`;
  if (recentAuditEntries.has(uniqueKey)) return;
  recentAuditEntries.add(uniqueKey);
  setTimeout(() => recentAuditEntries.delete(uniqueKey), 60_000);

  const executor = entry.executor;
  const actorId = executor?.id;
  const actionName = AuditLogEvent[entry.action] || `Audit action ${entry.action}`;
  await log(
    guild,
    `AUDIT EVENT — ${actionName}\nActor: ${formatActor(entry)}\nTarget: ${formatTarget(entry)}\nReason: ${entry.reason || "No reason provided"}\nTime: <t:${Math.floor(entry.createdTimestamp / 1000)}:F>`
  );

  if (!actorId || actorId === guild.ownerId || executor?.bot) return;

  if (entry.action === AuditLogEvent.RoleDelete) {
    await quarantine(guild, actorId, "Deleted a server role.", entry);
    return;
  }

  if (entry.action === AuditLogEvent.ChannelDelete) {
    const key = `${guild.id}:${actorId}`;
    const bucket = channelDeleteBuckets.get(key) || [];
    trimBucket(bucket, now() - CHANNEL_DELETE_WINDOW_MS);
    bucket.push({ time: now(), entry });
    channelDeleteBuckets.set(key, bucket);

    if (bucket.length >= CHANNEL_DELETE_LIMIT) {
      await quarantine(guild, actorId, `Deleted ${bucket.length} channels within ${CHANNEL_DELETE_WINDOW_MS / 1000} seconds.`, entry);
      channelDeleteBuckets.delete(key);
    }
    return;
  }

  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const ids = addedRoleIds(entry);
    if (!ids.length) return;
    const roles = await Promise.all(ids.map((id) => guild.roles.fetch(id).catch(() => null)));
    const powerful = roles.filter(isPowerfulRole);
    if (powerful.length) {
      await quarantine(
        guild,
        actorId,
        `Assigned powerful role(s): ${powerful.map((role) => role.name).join(", ")}.`,
        entry
      );
    }
    return;
  }

  if (entry.action === AuditLogEvent.RoleUpdate) {
    const role = entry.target?.id ? await guild.roles.fetch(entry.target.id).catch(() => null) : null;
    const before = entry.changes?.find((change) => change.key === "permissions")?.old;
    const after = entry.changes?.find((change) => change.key === "permissions")?.new;
    if (role && after !== undefined && isPowerfulRole(role) && before !== after) {
      await quarantine(guild, actorId, `Changed role "${role.name}" to include powerful permissions.`, entry);
    }
  }
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
  client.on("guildAuditLogEntryCreate", (entry, guild) => handleAuditEntry(entry, guild, settings));
  client.on("guildCreate", (guild) => captureGuildSnapshot(guild));
  client.once("ready", () => {
    for (const guild of client.guilds.cache.values()) {
      captureGuildSnapshot(guild).catch((error) => console.error("Snapshot failed:", error));
    }
  });
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
  quarantine,
};
