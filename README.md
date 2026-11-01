# Claw Utils

Claw Utils is a Discord security bot built with discord.js v14 and Node.js 22.

## Deploy configuration

The app is a Discord Gateway worker, not a web server. Keep it running continuously. Do not configure an HTTP service or scale the app to zero.

Required Fly secrets:
- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID` (optional; when set, slash commands register to that server)

Optional environment variables:
- `SECURITY_LOG_CHANNEL_ID`: defaults to the configured security log channel.
- `BACKUP_DIR`: defaults to `./data/backups`.
- `SECURITY_DATA_DIR`: defaults to `./data`.

## Persistent backups

Backups are JSON exports of server structure (roles, channels, positions, and permission overwrites). They do not include messages, member lists, tokens, or private message content.

The default container filesystem is ephemeral. Before relying on backups, create a Fly volume named `claw_data` in region `ord`, then set:
- `BACKUP_DIR=/data/backups`
- `SECURITY_DATA_DIR=/data`

Mount that volume at `/data` in `fly.toml` with:

```toml
[[mounts]]
  source = "claw_data"
  destination = "/data"
```

Do not add the mount until the volume exists. After mounting, create a new backup and confirm `/security status` reports persistent storage.

## Discord setup

Enable these privileged gateway intents in the Developer Portal:
- Server Members Intent
- Message Content Intent

Invite permissions needed by enabled features:
- View Channels
- View Audit Log
- Send Messages
- Read Message History
- Manage Messages
- Manage Roles
- Manage Channels
- Moderate Members
- Manage Server

Place the bot's highest role above roles it must remove or manage. Never grant Administrator unless absolutely required. Configure the security log channel so the bot can view and send messages there.

## Commands

All `/security` commands are restricted to the server owner:
- `/security status`: protection and backup status.
- `/security automod`: install built-in Discord AutoMod rules.
- `/security snapshot`: refresh the in-memory structure snapshot.
- `/security backup`: write a JSON structure backup.

## Important safety limits

- Owner is the only account exempt from automatic security actions.
- Role deletion triggers containment of the actor.
- Three channel deletions by one actor in 15 seconds trigger containment.
- Granting or creating a role with powerful permissions triggers containment.
- Adding a bot triggers containment of the actor; review the audit log before taking further action.
- Three bans/kicks or three webhook creations by one actor in 15 seconds trigger containment.
- Join bursts are logged; accounts younger than the configured threshold are contained during a detected burst.
- Known impersonation-style Discord/Steam scam URLs are deleted and logged. Repeated detections can trigger a timeout.
- Anti-spam and suspicious-link detection can produce false positives. Review security logs and test in a private server before relying on automatic actions.

## Backup restoration

Restore is intentionally not automated yet. A backup is a recovery reference, not a command to overwrite a live server. Review a backup and use a dry-run restoration plan before applying structural changes. This avoids accidentally overwriting newer channels, permissions, or roles.

## Operations

Run one Fly machine for this bot. Multiple machines can create duplicate gateway sessions and duplicate security actions. Keep one machine running and stop any extra machine after verifying the active instance is healthy.

The project has not been integration-tested against a live Discord server in this workspace. Test every containment action in a private test server before production use.
