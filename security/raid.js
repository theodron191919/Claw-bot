const config = require("./config");
const logger = require("./logger");
const quarantine = require("./quarantine");

const joins = new Map();

async function handle(member) {
  if (!config.raid.enabled || member.user.bot) return;
  const guild = member.guild;
  const now = Date.now();
  const recent = (joins.get(guild.id) || []).filter((time) => now - time <= config.raid.windowMs);
  recent.push(now);
  joins.set(guild.id, recent);

  const ageMs = now - member.user.createdTimestamp;
  const ageDays = ageMs / 86_400_000;
  if (recent.length >= config.raid.joinLimit) {
    await logger.send(guild, "POSSIBLE JOIN RAID", {
      Joins: recent.length + " in " + config.raid.windowMs / 1000 + " seconds",
      LatestAccount: member.user.id,
      AccountAgeDays: ageDays.toFixed(2),
    });

    if (ageDays < config.raid.accountAgeDays) {
      await quarantine.apply(guild, member.id, "New account joined during a detected join raid.", {
        incidentId: "raid-" + guild.id + "-" + now,
      });
    }
  }
}

module.exports = { handle };
