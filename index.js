const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } = require("discord.js");
const security = require("./security");
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
if (!token || !clientId) throw new Error("DISCORD_TOKEN and CLIENT_ID are required.");
const commands = [new SlashCommandBuilder().setName("security").setDescription("Manage security.").addSubcommand(s => s.setName("status").setDescription("Show protection and backup status.")).addSubcommand(s => s.setName("automod").setDescription("Install AutoMod rules.")).addSubcommand(s => s.setName("snapshot").setDescription("Refresh the in-memory snapshot.")).addSubcommand(s => s.setName("backup").setDescription("Create a server structure backup.")).toJSON()];
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.once(Events.ClientReady, async c => {
  console.log("Claw Utils online as " + c.user.tag);
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log("Slash commands registered.");
});
client.on(Events.InteractionCreate, async interaction => {
  try { await security.execute(interaction); }
  catch (error) {
    console.error(error);
    const response = { content: "That action failed. Check the bot logs.", ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});
client.on(Events.Error, error => console.error(error));
security.initialize(client).catch(error => { console.error(error); process.exit(1); });
client.login(token);
