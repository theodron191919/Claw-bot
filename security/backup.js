const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("./config");

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

async function list(guildId) {
  await fs.mkdir(root, { recursive: true });
  const names = (await fs.readdir(root)).filter((name) =>
    name.startsWith("guild-" + guildId + "-") && name.endsWith(".json")
  ).sort().reverse();
  return names.slice(0, 10);
}

module.exports = { create, list, root, durable: root.startsWith("/data/") };
