const config = require("./config");

function safe(value) {
  return String(value ?? "Unknown").replace(/[`*_~|]/g, "").slice(0, 900);
}

async function send(guild, title, fields = {}) {
  const lines = [`[CLAW SECURITY] ${safe(title)}`];
  for (const [key, value] of Object.entries(fields)) lines.push(`${safe(key)}: ${safe(value)}`);
  const content = lines.join("\n").slice(0, 1900);
  let channel = guild.channels.cache.get(config.logChannelId);
  if (!channel) channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased() || typeof channel.send !== "function") {
    console.error("Security log channel unavailable for guild", guild.id, content);
    return false;
  }
  try {
    await channel.send({ content, allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    console.error("Security log delivery failed:", error.message);
    return false;
  }
}

module.exports = { send };
