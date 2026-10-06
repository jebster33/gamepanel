# Alerts, Discord and the status page

## Alerts

**Settings → Alerts.** Paste a webhook URL and tick what should send an alert. **Send test** checks it.

The URL can be:

- **Discord:** channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
- **Slack:** an incoming webhook URL.
- **ntfy:** `https://ntfy.sh/<a-long-secret-topic>` for free phone push with no account (install the ntfy
  app and subscribe to the same topic).

Things you can be told about: a server crashes, an install or update fails, a server finishes installing,
comes online, stops or stops because it's empty; a server goes over its CPU, memory or disk alert; the
panel's disk is almost full; repeated failed sign-ins; someone signs in, or signs in from a new address;
a backup is made, fails, is copied to the cloud or fails to copy; a scheduled task fails; the panel
updates itself.

**Per-server thresholds** live on each server's **Settings → Alerts**: CPU above, memory above (% of its
limit), folder bigger than, and TPS below for Paper and Purpur. Each has to hold for 2 minutes before it
fires.

The [phone app](first-setup.md#phone-app) can push the same alerts to your phone.

## Discord bot

**Settings → Discord bot** lets your Discord use `/status`, `/players`, `/whois`, `/start`, `/stop` and
`/restart`. It connects out to Discord, so no port needs opening.

1. At [discord.com/developers](https://discord.com/developers/applications), create an application, add a
   **Bot** and copy its token into **Bot token**.
2. Invite the bot to your Discord server.
3. Under **Who can start/stop**, list the Discord user IDs allowed to start, stop and restart (turn on
   Developer Mode in Discord, right-click a user, **Copy User ID**). Everyone can use `/status`,
   `/players` and `/whois`.

### Player count in the member list

Under the bot settings, **Players in the bot's status** makes the bot's status read the number of players
online out of the maximum, like `25/200 players`, for all servers together or one, updated every 20
seconds. The text is yours to change (`{online}`, `{max}`, `{server}`, `{servers}`), shown as just the
text, *Playing …* or *Watching …*. It turns
to *Server offline* (red) and *Starting…* (yellow) by itself.

For one bot per server, the way big communities list each server in the sidebar, add **status bots**:
make an extra application and bot in the developer portal, paste its token and pick the server. Status
bots need no permissions and read no messages.

## A server's own Discord channel

Each server's **Settings → Discord channel** posts its chat, joins and leaves, and starts and crashes into
a channel through a webhook. Tick **Messages in the channel show up in game** to make it two-way; that
part goes through the Discord bot above, which needs **Message Content Intent** turned on in the
developer portal.

## Chat announcements

On a server's **Schedules** tab: rotating messages in game chat, and a welcome for players joining for
the first time. **Servers → Message all** sends one message to every running server.

## Public status page

**Settings → Public status page → Turn on the status page** gives you a link anyone can open without
signing in, good for a Discord channel. Pick which servers it lists, a title and description, whether it
shows player names, and the address players should use.

It shows which servers are up, who's on, 30-day uptime bars, the most played servers, leaderboards
(kills, blocks mined, distance, deaths) and the live map link where there is one. Maintenance mode shows
there too.
