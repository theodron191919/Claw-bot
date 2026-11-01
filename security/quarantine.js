const { PermissionFlagsBits, OverwriteType } = require("discord.js");
const config = require("./config");
const logger = require("./logger");

const deny = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.UseApplicationCommands,
];

const locks = new Map();

async function getRole(guild) {
  let role = guild.roles.cache.find((item) => item.name === config.quarantineRoleName);
  if (!role) {
    role = await guild.roles.create({
      name: config.quarantineRoleName,
      permissions: [],
      reason: "Claw Utils containment role",
    });
  }
  return role;
}

async function apply(guild, userId, reason, metadata = {}) {
  if (!config.quarantine.enabled || !userId) return false;
  if (config.ownerExempt && userId === guild.ownerId) return false;

  const key = guild.id + ":" + userId;
  if (locks.has(key)) return locks.get(key);

  const task = (async () => {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot || !member.manageable) {
      await logger.send(guild, "CONTAINMENT FAILED", {
        User: userId,
        Reason: reason,
        Detail: "Member unavailable or above the bot in role hierarchy.",
      });
      return false;
    }

    try {
      const role = await getRole(guild);
      const removable = member.roles.cache.filter((r) =>
        r.id !== guild.id && r.id !== role.id && !r.managed && r.editable
      );
      if (removable.size) await member.roles.remove(removable, "Claw Utils: " + reason);
      await member.roles.add(role, "Claw Utils: " + reason);

      const channels = await guild.channels.fetch();
      const results = await Promise.allSettled(
        [...channels.values()].filter(Boolean).map((channel) =>
          channel.permissionOverwrites.edit(role, {
            ViewChannel: false,
            SendMessages: false,
            SendMessagesInThreads: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            AddReactions: false,
            Connect: false,
            Speak: false,
            Stream: false,
            UseApplicationCommands: false,
          }, { reason: "Claw Utils quarantine lockdown" })
        )
      );
      const failedOverwrites = results.filter((r) => r.status === "rejected").length;
      await member.timeout(config.quarantine.timeoutMs, "Claw Utils: " + reason);

      await logger.send(guild, "MEMBER QUARANTINED", {
        User: userId,
        Reason: reason,
        RemovedRoles: removable.size,
        ChannelOverwritesFailed: failedOverwrites,
        Timeout: "28 days",
        Incident: metadata.incidentId || "Not assigned",
      });
      return failedOverwrites === 0;
    } catch (error) {
      await logger.send(guild, "CRITICAL CONTAINMENT ERROR", {
        User: userId,
        Reason: reason,
        Error: error.message,
      });
      return false;
    }
  })().finally(() => locks.delete(key));

  locks.set(key, task);
  return task;
}

module.exports = { apply };
