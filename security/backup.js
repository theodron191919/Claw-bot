const fs = require("node:fs/promises");
const path = require("node:path");

const root = process.env.BACKUP_DIR || path.join(process.cwd(), "data", "backups");

async function create(guild) {
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  const snapshot = {
    schemaVersion: 1,
    guildId: guild.id,
    guildName: guild.name,
    capturedAt: new Date().toISOString(),
    roles: guild.roles.cache
      .filter((role) => role.id !== guild.id && !role.managed)
      .map((role) => ({
        id: role.id, name: role.name, color: role.color,
        hoist: role.hoist, mentionable: role.mentionable,
        permissions: role.permissions.bitfield.toString(),
        position: role.position,
      })),
    channels: guild.channels.cache.map((channel) => ({
      id: channel.id, name: channel.name, type: channel.type,
      parentId: channel.parentId || null, topic: channel.topic || null,
      nsfw: Boolean(channel.nsfw), rateLimitPerUser: channel.rateLimitPerUser || 0,
      position: channel.rawPosition,
      permissionOverwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id, type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      })),
    })),
  };
  await fs.mkdir(root, { recursive: true });
  const filename = "guild-" + guild.id + "-" + Date.now() + ".json";
  const destination = path.join(root, filename);
  await fs.writeFile(destination, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
  return { filename, destination, roles: snapshot.roles.length, channels: snapshot.channels.length };
}


async function restoreChannels(guild, filename) {
  if (typeof filename !== "string" || path.basename(filename) !== filename || !filename.endsWith(".json")) {
    throw new Error("Invalid backup filename.");
  }
  if (!filename.startsWith("guild-" + guild.id + "-")) {
    throw new Error("That backup does not belong to this server.");
  }
  const snapshot = JSON.parse(await fs.readFile(path.join(root, filename), "utf8"));
  if (snapshot.schemaVersion !== 1 || snapshot.guildId !== guild.id || !Array.isArray(snapshot.channels)) {
    throw new Error("Unsupported or invalid backup.");
  }
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  const categories = snapshot.channels.filter(c => c.type === 4);
  const others = snapshot.channels.filter(c => c.type !== 4);
  const ordered = [...categories, ...others];
  const oldCategoryIds = new Set(categories.map(c => c.id));
  const restored = new Map();
  const result = { created: 0, skipped: 0, unsupported: 0, failed: 0 };

  for (const saved of ordered) {
    if (![0, 2, 4, 5, 13, 15].includes(saved.type)) {
      result.unsupported++;
      continue;
    }
    const existing = guild.channels.cache.find(c => c.name === saved.name && c.type === saved.type);
    if (existing) {
      restored.set(saved.id, existing.id);
      result.skipped++;
      continue;
    }
    const permissionOverwrites = [];
    for (const item of saved.permissionOverwrites || []) {
      let targetId = null;
      if (item.id === snapshot.guildId) targetId = guild.id;
      if (item.type === 0 && item.id !== snapshot.guildId) {
        const oldRole = (snapshot.roles || []).find(r => r.id === item.id);
        const role = oldRole && guild.roles.cache.find(r => r.name === oldRole.name);
        if (role) targetId = role.id;
      }
      if (targetId) permissionOverwrites.push({
        id: targetId, type: item.type, allow: item.allow, deny: item.deny
      });
    }
    const options = {
      name: saved.name, type: saved.type, permissionOverwrites,
      reason: "Claw Utils restore from " + filename
    };
    if (saved.topic) options.topic = saved.topic;
    if (saved.nsfw !== undefined) options.nsfw = saved.nsfw;
    if (saved.rateLimitPerUser) options.rateLimitPerUser = saved.rateLimitPerUser;
    if (saved.type !== 4 && saved.parentId && oldCategoryIds.has(saved.parentId)) {
      const parent = restored.get(saved.parentId);
      if (parent) options.parent = parent;
    }
    try {
      const channel = await guild.channels.create(options);
      restored.set(saved.id, channel.id);
      result.created++;
    } catch (error) {
      result.failed++;
      console.error("Restore failed for " + saved.name + ":", error);
    }
  }
  return result;
}

async function list(guildId) {
  await fs.mkdir(root, { recursive: true });
  const names = (await fs.readdir(root)).filter((name) =>
    name.startsWith("guild-" + guildId + "-") && name.endsWith(".json")
  ).sort().reverse();
  return names.slice(0, 10);
}

module.exports = { create, list, restoreChannels, root, durable: root.startsWith("/data/") };
