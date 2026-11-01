const { PermissionFlagsBits } = require("discord.js");
const logger = require("./logger");

const suspiciousPatterns = [
  /discord[.-]gift/i,
  /discordapp[.-]gift/i,
  /free[.-]?nitro/i,
  /steamcomm?un[i1]ty/i,
  /steamcomrnunity/i,
  /dlscord/i,
  /disc0rd/i,
  /nitro[.-]claim/i,
];
const recent = new Map();

async function handle(message) {
  if (!message.guild || message.author.bot || !message.member || message.author.id === message.guild.ownerId) return;
  const text = message.content || "";
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) || [];
  if (!urls.length) return;
  const hit = urls.find((url) => suspiciousPatterns.some((pattern) => pattern.test(url)));
  if (!hit) return;

  const key = message.guild.id + ":" + message.author.id;
  const count = (recent.get(key) || 0) + 1;
  recent.set(key, count);
  await message.delete().catch(() => {});
  let timedOut = false;
  if (count >= 2 && message.member.moderatable) {
    timedOut = await message.member.timeout(10 * 60 * 1000, "Repeated suspicious link detection")
      .then(() => true).catch(() => false);
  }
  await logger.send(message.guild, "SUSPICIOUS LINK BLOCKED", {
    User: message.author.id,
    Channel: message.channel.id,
    Link: hit.slice(0, 500),
    RepeatDetections: count,
    TimeoutApplied: timedOut,
  });
  if (count >= 3) recent.delete(key);
}

module.exports = { handle };
