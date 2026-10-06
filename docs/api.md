# HTTP API

Everything the UI does is a REST call. Authenticate with the session cookie, `Authorization: Bearer <token>` from `POST /api/auth/login`, or an API key.

## Rate limits

Signed-in accounts (and their keys) get 1200 requests a minute; anything anonymous, like the sign-in and public status endpoints, gets 120 a minute per address. Past that the API answers `429` with a `Retry-After` header.

## API keys

Create one on the Account page (or `POST /api/auth/api-keys {"name","readOnly"}`; the key is shown once). Send it as `Authorization: Bearer gp_…`. A key acts as your account, with two limits: read-only keys can only `GET`, and no key can change accounts (passwords, two-factor, keys, users). Keys are stored hashed.

```
curl -H "Authorization: Bearer gp_…" http://panel:8420/api/servers
curl -H "Authorization: Bearer gp_…" -H "Content-Type: application/json" \
     -d '{"action":"restart"}' http://panel:8420/api/servers/<id>/power
```

```
GET    /api/servers                      list servers
POST   /api/servers                      create + install
POST   /api/servers/:id/power            {"action":"start|stop|restart|kill"}
POST   /api/servers/:id/command          {"command":"say hello"}
GET    /api/servers/:id/console          scrollback
GET    /api/servers/:id/history          metrics history
GET    /api/servers/:id/files?path=      file explorer
GET    /api/servers/:id/files/search?q=  file names and text in config files
POST   /api/servers/:id/files/extract    unpack an archive
POST   /api/servers/:id/files/compress   pack a selection
GET    /api/servers/:id/mods             providers, loader/version filter, installed mods
GET    /api/servers/:id/mods/search      search a provider (only compatible builds)
GET    /api/servers/:id/mods/versions    compatible versions of one mod
POST   /api/servers/:id/mods/plan        what an install brings in, dependencies included
POST   /api/servers/:id/mods/install     install a mod and its dependencies
GET    /api/servers/:id/mods/updates     newer compatible releases
POST   /api/servers/:id/mods/update      {"keys":[…]} or {"all":true}
DELETE /api/servers/:id/mods/:key        remove (and dependencies nothing else needs)
POST   /api/servers/:id/mods/:key/toggle enable or disable
GET    /api/servers/:id/schedules        scheduled tasks
POST   /api/servers/:id/schedules        {"name","action","cron","command?"}
GET    /api/servers/:id/backups          backups
GET    /api/servers/:id/player-history   players, sessions, peaks
GET    /api/servers/:id/activity         joins, leaves, chat, kicks (?types=&q=&before=, &format=csv to download)
GET    /api/servers/:id/player-lists     whitelist, ops, bans (Minecraft)
POST   /api/servers/:id/player-lists     {"list","action":"add|remove","name"}
GET    /api/servers/:id/version          version fields and server types
POST   /api/servers/:id/version          {"templateId?","vars","backup","stopFirst"}
GET    /api/servers/:id/worlds           worlds and which one loads
POST   /api/servers/:id/worlds/use       {"name"}
POST   /api/servers/:id/worlds/reset     {"name","seed?","backup"}
GET    /api/servers/:id/worlds/download  ?name= (a .tar.gz)
POST   /api/servers/:id/clone            {"name","copyFiles"} (admins)
POST   /api/servers/:id/crossplay        {"enabled"} Geyser + Floodgate (Paper/Purpur)
POST   /api/servers/:id/map              {"enabled"} BlueMap live web map (Paper/Purpur)
GET    /api/servers/:id/gamerules        Minecraft Java game rules (server running)
PUT    /api/servers/:id/gamerules        {"name","value"} change one live over RCON
POST   /api/servers/:id/pregen           {"action":"install|start|pause|continue|cancel","radius?"} Chunky pre-generation
PUT    /api/servers/:id/subdomain        {"name"} Cloudflare A (+ SRV) record (admins)
POST   /api/players/ban-everywhere       {"name","reason","unban?"} every Minecraft server
POST   /api/servers/broadcast        {"message"} say it in chat on every running server
GET    /api/players/search?q=            players on any visible server (admins: also by address)
GET    /api/servers/:id/backups/:name/contents        files in a backup
POST   /api/servers/:id/backups/:name/restore-files   {"paths"} put back single files or folders
PUT    /api/servers/:id/announcements    {"enabled","every","messages","welcome?":{"enabled","message"}} rotating chat, first-join welcome
GET    /api/servers/:id/logs             ?q= search logs/ (gzipped days too), ?file= read one
PUT    /api/servers/:id/maintenance      {"enabled","message?"} whitelist on, kick non-ops, MOTD
PUT    /api/players/:name/note           {"note","watch"} staff note; watch = alert on join
PUT    /api/servers/:id/discord-feed      {"webhook","chat","joins","status","fromDiscord","test?"} chat relay to a channel and back
POST   /api/system/panel-backup          {"password"} accounts, settings, keys, player history as .tar.gz (admins)
GET    /api/servers/:id/export           whole server as .tar.gz with gamepanel-server.json (admins)
GET    /api/servers/:id/diagnose         crash doctor findings
POST   /api/servers/:id/share-log        upload the console to mclo.gs
GET    /api/notifications                recent events this account may see (the bell)
GET    /api/servers/:id/config-history   files with saved versions
GET    /api/servers/:id/config-history/versions?path=        versions of one file
GET    /api/servers/:id/config-history/version?path=&version= one version's content
POST   /api/servers/:id/config-history/revert                {"path","version"} put it back
GET    /api/quota                        your quota and what you use of it (self-service accounts)
GET    /api/setups                       ready-made setups
POST   /api/setups/:id/deploy            {"name","memory"} create a server from one
GET    /api/servers/:id/events           scheduled events (optional feature)
POST   /api/servers/:id/events           {"name","cron","hours","changes":{key:value},"announce","restart"}
POST   /api/servers/:id/events/:eid/start|end   run or end one now
POST   /api/servers/:id/network/check    can the internet reach it? (mcsrvstat.us, portchecker.io)
GET    /api/servers/:id/world-map        Rust, Valheim and Terraria map links
GET    /api/servers/:id/workshop-packs   saved Workshop packs for this game
POST   /api/servers/:id/workshop-packs   {"name","input"} or {"name","fromServer":true}
POST   /api/servers/:id/workshop-packs/:pid/apply   add a pack's items
GET    /api/servers/:id/modpacks/diff    ?source=&project=&version= mods added, removed, updated
GET    /api/auth/oauth/providers         sign-in buttons that are set up
GET    /api/auth/oauth/:p/start          sign in with google|discord|github (?link=1 links instead)
GET    /api/settings/oauth               providers, client ids and redirect URLs (admins)
PUT    /api/settings/oauth               {"publicUrl","discord":{"clientId","clientSecret"}} (admins)
GET    /api/servers/:id/wipe             ?blueprints=1 files a wipe would delete (games with a wipe spec)
POST   /api/servers/:id/wipe             {"blueprints","newSeed","updateFirst"} wipe now
POST   /api/servers/:id/save-as-setup    {"name","description"} keep it as a ready-made setup (admins)
POST   /api/servers/:id/backups/:name/verify          test-restore one backup
PUT    /api/servers/:id/backup-mode      {"mode":"archive|incremental","encrypt"}
PUT    /api/settings/backup-passphrase   {"passphrase"} for encrypted backups (admins)
GET    /api/servers/:id/mods/check       mod check: wrong loader, missing dependencies, clashes
GET    /api/servers/:id/configs          plugin and mod config files
GET    /api/servers/:id/configs/form     ?path= one file as a form
PUT    /api/servers/:id/configs/form     ?path= {"version","changes":{id:value}}
GET    /api/servers/:id/moderation       chat moderation settings and temporary bans
PUT    /api/servers/:id/moderation       {"enabled","words","links","allowDomains","caps","spam","ladder","muteMinutes","banHours","forgetHours","exempt"}
GET    /api/bans                         shared ban list, appeals, servers (admins)
POST   /api/bans                         {"name","reason","hours?"} ban on every server
DELETE /api/bans/:id                     lift it everywhere
POST   /api/bans/appeals/:id             {"decision":"accept|deny","reply"}
POST   /api/public/appeals               {"name","message","contact"} (public; returns a code)
GET    /api/public/appeals/:code         an appeal's status (public)
GET    /api/servers/:id/discord-whitelist     whitelist from Discord roles
PUT    /api/servers/:id/discord-whitelist     {"enabled","guildId","roles","source":"link|nickname"}
GET    /api/import/scan                  Pterodactyl, AMP and LinuxGSM servers on this machine (admins)
POST   /api/import/pterodactyl           {"url","key"} names and ports from a Pterodactyl panel
POST   /api/import/inspect               {"path"} which game a folder holds
POST   /api/move                         {"serverId","to":"local|<node id>","keepSource"} move to another node
GET    /api/networks                     Velocity networks (admins)
POST   /api/networks                     {"name","proxyId","servers":[{"serverId","name"}]}
GET    /api/settings/https               HTTPS settings and certificate (admins)
PUT    /api/settings/https               {"enabled","domain","email","method":"http|cloudflare","port","redirect","staging"}
POST   /api/settings/https/issue         get or renew the certificate now
GET    /api/settings/sftp                SFTP settings and host key (admins)
PUT    /api/settings/sftp                {"enabled","port"}
POST   /api/auth/passkeys/options        start adding a passkey; POST /api/auth/passkeys finishes it
POST   /api/auth/passkey/options         start a passkey sign-in; POST /api/auth/passkey/login finishes it
GET    /api/settings/status-bots         players-in-status settings and status bots (admins)
PUT    /api/settings/status-bots         {"main":{"mode":"off|all|server","serverId","format","style"},"bots":[{"id?","token?","serverId","format","style"}]}
GET    /api/servers/:id/players/:name/inventory          ?backup= a Minecraft player's inventory, now or in a backup
POST   /api/servers/:id/players/:name/inventory/restore  {"backup"} put one player's file back (they must be offline)
GET    /api/servers/:id/datapacks        datapacks in the loaded world, with version check
GET    /api/servers/:id/datapacks/search ?query= Modrinth datapacks for the server's version
GET    /api/servers/:id/datapacks/updates
POST   /api/servers/:id/datapacks/install          {"projectId","versionId?"}
POST   /api/servers/:id/datapacks/upload           ?name=pack.zip (body: the zip)
POST   /api/servers/:id/datapacks/:name/toggle     {"on"}
DELETE /api/servers/:id/datapacks/:name
GET    /api/servers/:id/backups/:name/preview      what a full restore would change
POST   /api/servers/:id/backups/:name/restore      {"backupFirst","exact"}
POST   /api/templates/check              {"template"} errors, warnings and the install script (admins)
POST   /api/templates                    {"template","replace?"} save a custom game (admins)
GET    /api/templates/:id/source         a template as saved, for editing (admins)
GET    /api/node-backups                 copies-on-a-node settings (admins)
PATCH  /api/node-backups                 {"enabled","nodeId","keep"}
GET    /api/servers/:id/backups/node     copies on the node; POST …/node/:name/send|fetch, DELETE …/node/:name
PUT    /api/backup-store/:panel/:server/:name    the receiving node's store (admin API key; body: the .tar.gz)
GET    /api/servers/:id/advice           memory and settings advice
POST   /api/servers/:id/advice/:id/apply apply one piece of advice (admins)
POST   /api/servers/:id/staging          {"name","withWorld"} make a staging copy (admins)
GET    /api/servers/:id/staging/diff     what a push from this staging copy would change
POST   /api/servers/:id/staging/push     {"entries":[folders],"properties","version"}
PATCH  /api/servers/:id                  … {"wakeOnJoin":true} turns on wake on join (Minecraft Java)
GET    /api/system                       host metrics
GET    /api/system/runtime               Docker status
GET    /api/system/update                pending panel updates
POST   /api/system/update                update and restart
```

`WS /ws` streams `servers`, `stats`, `system`, `server:status`, `notification` and `console:<id>`.
