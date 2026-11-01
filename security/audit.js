const { AuditLogEvent } = require("discord.js");
const config = require("./config");
const logger = require("./logger");
const quarantine = require("./quarantine");

const seen = new Set();
const channelDeletes = new Map();
const destructiveActions = new Map();
const webhookCreates = new Map();

function countRecent(map, key, windowMs) {
  const cutoff = Date.now() - windowMs;
  const recent = (map.get(key) || []).filter((time) => time >= cutoff);
  recent.push(Date.now());
  map.set(key, recent);
  return recent.length;
}

function getAddedRoles(entry) {
  const change = entry.changes?.find((item) => item.key === "$add");
  return Array.isArray(change?.new) ? change.new.map((role) => role.id) : [];
}

async function handle(entry, guild) {
  if (!config.watchedAuditActions.some((name) => AuditLogEvent[name] === entry.action)) return;
  if (seen.has(entry.id)) return;
  seen.add(entry.id);
  setTimeout(() => seen.delete(entry.id), config.audit.dedupeMs);

  const actorId = entry.executorId || entry.executor?.id;
  const targetId = entry.targetId || entry.target?.id;
  const action = AuditLogEvent[entry.action] || String(entry.action);
  await logger.send(guild, "AUDIT EVENT", {
    Action: action,
    Actor: actorId || "Unknown",
    Target: targetId || "Unknown",
    Reason: entry.reason || "No audit reason supplied",
    Timestamp: new Date(entry.createdTimestamp).toISOString(),
  });

  if (!actorId || actorId === guild.ownerId || entry.executor?.bot) return;

  if (entry.action === AuditLogEvent.BotAdd) {
    await quarantine.apply(guild, actorId, "Added a bot to the server; owner approval is required.", { incidentId: entry.id });
    return;
  }

  if (entry.action === AuditLogEvent.RoleCreate) {
    const createdRole = targetId ? await guild.roles.fetch(targetId).catch(() => null) : null;
    if (createdRole && createdRole.permissions.has(config.powerfulPermissions)) {
      await quarantine.apply(guild, actorId, "Created a role with powerful permissions: " + createdRole.name, { incidentId: entry.id });
    }
    return;
  }

  if (entry.action === AuditLogEvent.WebhookCreate) {
    const count = countRecent(webhookCreates, actorId, 15_000);
    if (count >= 3) {
      await quarantine.apply(guild, actorId, "Created " + count + " webhooks within 15 seconds.", { incidentId: entry.id });
    }
    return;
  }

  if ([AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick].includes(entry.action)) {
    const count = countRecent(destructiveActions, actorId, 15_000);
    if (count >= 3) {
      await quarantine.apply(guild, actorId, "Performed " + count + " bans/kicks within 15 seconds.", { incidentId: entry.id });
    }
    return;
  }

  if (entry.action === AuditLogEvent.RoleDelete) {
    await quarantine.apply(guild, actorId, "Deleted a server role.", { incidentId: entry.id });
    return;
  }

  if (entry.action === AuditLogEvent.ChannelDelete) {
    const bucket = channelDeletes.get(actorId) || [];
    const cutoff = Date.now() - config.audit.channelDeleteWindowMs;
    const recent = bucket.filter((item) => item.time >= cutoff);
    recent.push({ time: Date.now(), id: entry.id });
    channelDeletes.set(actorId, recent);
    if (recent.length >= config.audit.channelDeleteLimit) {
      await quarantine.apply(guild, actorId, "Deleted " + recent.length + " channels within 15 seconds.", { incidentId: entry.id });
      channelDeletes.delete(actorId);
    }
    return;
  }

  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const ids = getAddedRoles(entry);
    if (!ids.length) return;
    const roles = await Promise.all(ids.map((id) => guild.roles.fetch(id).catch(() => null)));
    const dangerous = roles.filter((role) => role && role.permissions.has(config.powerfulPermissions));
    if (dangerous.length) {
      await quarantine.apply(guild, actorId, "Granted powerful role(s): " + dangerous.map((role) => role.name).join(", "), { incidentId: entry.id });
    }
    return;
  }

  if (entry.action === AuditLogEvent.RoleUpdate) {
    const role = targetId ? await guild.roles.fetch(targetId).catch(() => null) : null;
    const before = entry.changes?.find((item) => item.key === "permissions")?.old;
    const after = entry.changes?.find((item) => item.key === "permissions")?.new;
    if (role && after !== undefined && before !== after && role.permissions.has(config.powerfulPermissions)) {
      await quarantine.apply(guild, actorId, "Modified role permissions to grant powerful access: " + role.name, { incidentId: entry.id });
    }
  }
}

module.exports = { handle };
