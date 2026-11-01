const {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  PermissionFlagsBits,
} = require("discord.js");
const audit = require("./security/audit");
const raid = require("./security/raid");
const logger = require("./security/logger");
const quarantine = require("./security/quarantine");
const config = require("./security/config");
const antiScam = require("./security/antiscam");
const backup = require("./security/backup");

const messageBuckets = new Map();
const snapshots = new Map();

function trim(bucket, cutoff) {
  while (bucket.length && bucket[0].time < cutoff) bucket.shift();
}

async function handleMessage(message) {
  if (!config.spam.enabled || !message.guild || message.author.bot || !message.member) return;
  if (message.author.id === message.guild.ownerId) return;

  const key = message.guild.id + ":" + message.author.id;
  const bucket = messageBuckets.get(key) || [];
  const content = (message.content || "").toLowerCase().replace(/\s+/g, " ").trim();
  const time = Date.now();
  trim(bucket, time - config.spam.windowMs);
  bucket.push({ time, content });
  messageBuckets.set(key, bucket);

  const duplicates = bucket.filter((item) => content && item.content === content).length;
  if (bucket.length < config.spam.messageLimit && duplicates < config.spam.duplicateLimit) return;

  const reason = "Automatic anti-spam threshold exceeded";
  const timedOut = await message.member.timeout(config.spam.timeoutMs, reason).then(() => true).catch(() => false);
  await message.delete().catch(() => {});
  await logger.send(message.guild, "ANTI-SPAM ACTION", {
    User: message.author.id,
    Channel: message.channel.id,
    TimeoutApplied: timedOut,
    Trigger: bucket.length + " messages / " + duplicates + " duplicates",
  });
  messageBuckets.delete(key);
}

async function captureGuildSnapshot(guild) {
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  const snapshot = {
    capturedAt: new Date().toISOString(),
    channels: guild.channels.cache.map((channel) => ({
      id: channel.id, name: channel.name, type: channel.type,
      parentId: channel.parentId, topic: channel.topic || null,
      nsfw: Boolean(channel.nsfw), position: channel.rawPosition,
    })),
    roles: guild.roles.cache.filter((role) => role.id !== guild.id).map((role) => ({
      id: role.id, name: role.name, permissions: role.permissions.bitfield.toString(),
      color: role.color, hoist: role.hoist, mentionable: role.mentionable,
      position: role.position,
    })),
  };
  snapshots.set(guild.id, snapshot);
  await logger.send(guild, "SNAPSHOT CAPTURED", {
    Channels: snapshot.channels.length,
    Roles: snapshot.roles.length,
    Storage: "Memory only; not a durable backup",
  });
  return snapshot;
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
      enabled: true, exemptRoles: [], exemptChannels: [],
    },
    {
      name: "Claw Utils - Mention spam",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: 5,
      triggerMetadata: { mentionTotalLimit: 5, mentionRaidProtectionEnabled: true },
      actions: [{ type: AutoModerationActionType.BlockMessage }],
      enabled: true, exemptRoles: [], exemptChannels: [],
    },
  ];
  const created = [];
  for (const rule of rules) {
    if (existing?.some((item) => item.name === rule.name)) continue;
    created.push(await guild.autoModerationRules.create(rule));
  }
  return created;
}

async function initialize(client) {
  client.on("messageCreate", (message) => {
    handleMessage(message).catch((error) => console.error("Anti-spam error:", error));
    antiScam.handle(message).catch((error) => console.error("Anti-scam error:", error));
  });
  client.on("guildAuditLogEntryCreate", (entry, guild) => audit.handle(entry, guild).catch((error) => console.error("Audit handler error:", error)));
  client.on("guildMemberAdd", (member) => raid.handle(member).catch((error) => console.error("Raid handler error:", error)));
  client.on("guildCreate", (guild) => captureGuildSnapshot(guild).catch((error) => console.error("Snapshot error:", error)));
  client.once("ready", () => {
    for (const guild of client.guilds.cache.values()) {
      captureGuildSnapshot(guild).catch((error) => console.error("Snapshot error:", error));
    }
  });
}

async function execute(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== "security") return false;
  if (!interaction.guild || interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({ content: "Only the server owner can use Claw Utils security controls.", ephemeral: true });
    return true;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "automod") {
    const rules = await installAutoMod(interaction.guild);
    await interaction.reply({
      content: rules.length ? "Installed " + rules.length + " AutoMod rule(s)." : "The Claw Utils AutoMod rules are already installed.",
      ephemeral: true,
    });
  } else if (subcommand === "backup") {
    const result = await backup.create(interaction.guild);
    await logger.send(interaction.guild, "STRUCTURE BACKUP CREATED", {
      File: result.filename,
      Channels: result.channels,
      Roles: result.roles,
      Storage: backup.durable ? "Persistent /data volume" : "Local container storage; may be lost on redeploy",
    });
    await interaction.reply({
      content: "Backup created: " + result.channels + " channels and " + result.roles + " roles. " + (backup.durable ? "Stored on the persistent /data volume." : "WARNING: storage is not persistent yet; configure a Fly volume before relying on backups."),
      ephemeral: true,
    });
  } else if (subcommand === "status") {
    const files = await backup.list(interaction.guild.id);
    await interaction.reply({
      content: [
        "Claw Utils security status",
        "Audit logging: enabled",
        "Anti-nuke containment: enabled",
        "Anti-raid detection: " + (config.raid.enabled ? "enabled" : "disabled"),
        "Anti-spam: " + (config.spam.enabled ? "enabled" : "disabled"),
        "Anti-scam link filter: enabled",
        "Recent structure backups: " + files.length,
        "Backup storage: " + (backup.durable ? "persistent volume path" : "temporary container storage"),
        "Owner exemption: server owner only",
      ].join("\n"),
      ephemeral: true,
    });
  } else if (subcommand === "snapshot") {
    const snapshot = await captureGuildSnapshot(interaction.guild);
    await interaction.reply({
      content: "Snapshot refreshed: " + snapshot.channels.length + " channels and " + snapshot.roles.length + " roles. This snapshot is currently memory-only.",
      ephemeral: true,
    });
  } else {
    await interaction.reply({ content: "Unknown security subcommand.", ephemeral: true });
  }
  return true;
}

module.exports = {
  name: "Security",
  description: "Modular anti-nuke, anti-raid, anti-spam, quarantine, audit logging, and AutoMod.",
  initialize,
  execute,
  captureGuildSnapshot,
  installAutoMod,
  quarantine: quarantine.apply,
};
