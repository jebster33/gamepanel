# HTTP API

Everything the UI does is a REST call. Authenticate with the session cookie (`POST /api/auth/login` sets it; the response does not carry the token) or an API key.

## Rate limits

Signed-in accounts (and their keys) get 1200 requests a minute; anything anonymous, like the sign-in and public status endpoints, gets 120 a minute per address. Past that the API answers `429` with a `Retry-After` header.

## API keys

Create one on the Account page (or `POST /api/auth/api-keys {"name","readOnly"}`; the key is shown once). Send it as `Authorization: Bearer gp_…`. A key acts as your account, with two limits: read-only keys can only `GET`, and no key can change accounts (passwords, two-factor, keys, users). Keys are stored hashed.

The [`gamepanel` command](guide/cli.md) wraps the common calls.

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
GET    /api/servers/:id/steam-branch     Steam branch of a SteamCMD server (never the password)
GET    /api/servers/:id/steam-branch/branches  branches Steam lists for the game
PUT    /api/servers/:id/steam-branch     {"branch","password?","clearPassword?"}
GET    /api/servers/:id/tshock           tShock detected? plugin folder
POST   /api/servers/:id/tshock/install-url  {"url"} https .dll/.zip into ServerPlugins (needs files.write)
POST   /api/servers/:id/tshock/upload    raw body, ?name=Plugin.dll (needs files.write)
GET    /api/servers/:id/sandbox          Zomboid sandbox options as a form (?file=)
PUT    /api/servers/:id/sandbox          {"file","version","changes":{"A.B":value}} (server stopped)
GET    /api/servers/:id/sevendays-map    generated world preview data (?world=)
GET    /api/servers/:id/sevendays-map/image  biomes.png of a world (?world=&file=)
GET    /api/servers/:id/nexus            Nexus Mods links for the game (?query=)
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
GET    /api/me/prefs                     your saved UI preferences (pinned, folders, tags, widgets, recent)
PUT    /api/me/prefs                     replace the sent keys (null resets one); validated, 32 KB max
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
                                                              path "@server-settings" is the server's own settings (needs "settings", not "files")
GET    /api/servers/:id/safe-update      the safe-update snapshot, if any
POST   /api/servers/:id/safe-update      back up, then update the game files (server stopped)
POST   /api/servers/:id/safe-update/rollback  restore the snapshot by hand (server stopped)
POST   /api/servers/:id/mods/update      add "safe": true to back up first
GET    /api/quota                        your quota and what you use of it (self-service accounts)
GET    /api/setups                       ready-made setups
POST   /api/setups/:id/deploy            {"name","memory"} create a server from one
GET    /api/servers/:id/events           scheduled events (optional feature)
POST   /api/servers/:id/events           {"name","cron","hours","changes":{key:value},"announce","restart"}
POST   /api/servers/:id/events/:eid/start|end   run or end one now
POST   /api/servers/:id/network/check    can the internet reach it? (mcsrvstat.us, portchecker.io)
GET    /api/servers/:id/world-map        Rust, Valheim and Terraria map links
GET    /api/servers/:id/rust-tools       Rust presets, day length and AFK kick settings
POST   /api/servers/:id/rust-tools/plugin {"plugin":"loot|stack"} install BetterLoot / StackSizeController
POST   /api/servers/:id/rust-tools/loot  {"preset":"2x"|"custom","multiplier"} BetterLoot loot multiplier
POST   /api/servers/:id/rust-tools/stack {"preset":"5x"|"custom","all","categories"} StackSizeController
PUT    /api/servers/:id/rust-tools/time  {"preset"|"day","night"} env.daylength / env.nightlength
PUT    /api/servers/:id/rust-tools/afk   AFK and high-ping kick settings
GET    /api/servers/:id/rust-teams       teams, members, bases, clans (console permission)
GET    /api/servers/:id/rust-entities    entities per player, ranked (console permission)
GET    /api/servers/:id/rust-info        public-safe server card and join link
GET    /api/servers/:id/workshop-packs   saved Workshop packs for this game
POST   /api/servers/:id/workshop-packs   {"name","input"} or {"name","fromServer":true}
POST   /api/servers/:id/workshop-packs/:pid/apply   add a pack's items
GET    /api/servers/:id/mods/share        the player mod page settings
PATCH  /api/servers/:id/mods/share        {"enabled","notes","extras":[{"name","url","note"}],"newLink"}
GET    /api/public/mods/:slug             mods players need (public, while sharing is on)
GET    /api/public/mods/:slug/pack.mrpack Modrinth modpack of those mods (public)
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
GET    /api/servers/:id/mods/check       mod check: wrong loader, missing dependencies, clashes (Minecraft, Rust, Factorio, the panel's record)
GET    /api/servers/:id/configs          plugin and mod config files
GET    /api/servers/:id/configs/form     ?path= one file as a form
PUT    /api/servers/:id/configs/form     ?path= {"version","changes":{id:value}}
GET    /api/servers/:id/moderation       chat moderation settings and temporary bans
PUT    /api/servers/:id/moderation       {"enabled","words","links","allowDomains","caps","spam","ladder","muteMinutes","banHours","forgetHours","exempt"}
GET    /api/bans                         shared ban list, appeals, servers (admins)
POST   /api/bans                         {"name","reason","hours?"} ban on every server
DELETE /api/bans/:id                     lift it everywhere
POST   /api/bans/appeals/:id             {"decision":"accept|deny","reply"}
GET    /api/staff/activity               per-staff moderation counts per day/week, last active, recent actions (admins)
GET    /api/staff/reasons                ban/kick reason templates (any signed-in user)
POST   /api/staff/reasons                {"name","reason","hours","appeal"} (admins); PUT/DELETE …/:id
                                         ban/kick routes (POST /api/bans, /api/players/ban-everywhere, /api/servers/:id/players/action, …/player-lists) also take {"template": id}
GET    /api/staff/roles                  role templates and the permissions they can hold (admins)
POST   /api/staff/roles                  {"name","description","permissions"} (admins); PUT/DELETE …/:id (delete resets a built-in)
POST   /api/servers/:id/access/:userId/role   {"role": id} apply a role template to a sub-user (admins)
GET    /api/servers/:id/access-grants    active time-limited grants (admins)
POST   /api/servers/:id/access-grants    {"userId","role" or "permissions","hours" or "until"} (admins)
DELETE /api/servers/:id/access-grants/:grantId   end one early
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
GET    /api/clusters                     ARK clusters (admins)
POST   /api/clusters                     {"name","servers":[serverId],"options":{"uploadDinos","downloadDinos","survivorExpirySeconds",…}}
PUT    /api/clusters/:id                 same body; DELETE removes the cluster
GET    /api/clusters/:id/transfers       files in the cluster folder and transfer lines from member logs (admins)
GET    /api/servers/:id/ark/mods         ARK mod load order; PUT {"mods":[id,…]} saves it
GET    /api/servers/:id/ark/levels       level cap and engram overrides from Game.ini; PUT saves them; POST …/preview {"cap","firstXp","finalXp","curve"} (or {"kind":"points",…}) calculates
GET    /api/servers/:id/ark/crates       supply crate overrides; PUT {"crates":[…]} saves them
GET    /api/servers/:id/ark/items        ?q=&category=&limit= item catalog search
POST   /api/servers/:id/ark/give         {"player","playerId","path","quantity","tier"|"quality","blueprint","style"} sends GiveItemToPlayer
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
GET    /api/servers/:id/resource-pack    the hosted resource pack (Minecraft Java) and its public address
POST   /api/servers/:id/resource-pack    ?name=pack.zip (body: the zip) host it and set server.properties
PATCH  /api/servers/:id/resource-pack    {"require","prompt","baseUrl","newLink"}
DELETE /api/servers/:id/resource-pack
GET    /api/public/resource-pack/:slug/pack.zip   public: the pack itself, nothing else
GET    /api/servers/:id/backups/:name/preview      what a full restore would change
POST   /api/servers/:id/backups/:name/restore      {"backupFirst","exact"}
POST   /api/templates/check              {"template"} errors, warnings and the install script (admins)
POST   /api/templates                    {"template","replace?"} save a custom game (admins)
GET    /api/templates/:id/source         a template as saved, for editing (admins)
GET    /api/node-backups                 copies-on-a-node settings (admins)
PATCH  /api/node-backups                 {"enabled","nodeId","keep"}
GET    /api/servers/:id/backups/node     copies on the node; POST …/node/:name/send|fetch, DELETE …/node/:name
PUT    /api/backup-store/:panel/:server/:name    the receiving node's store (admin API key; body: the .tar.gz)
GET    /api/servers/:id/lag              lag reports and the one running (console)
POST   /api/servers/:id/lag              take one: {mode: profile|health, seconds} (command)
DELETE /api/servers/:id/lag/:reportId    delete a report (command)
GET    /api/servers/:id/advice           memory and settings advice
POST   /api/servers/:id/advice/:id/apply apply one piece of advice (admins)
POST   /api/servers/:id/staging          {"name","withWorld"} make a staging copy (admins)
GET    /api/servers/:id/staging/diff     what a push from this staging copy would change
POST   /api/servers/:id/staging/push     {"entries":[folders],"properties","version"}
PATCH  /api/servers/:id                  … {"wakeOnJoin":true} turns on wake on join (Minecraft Java)
GET    /api/servers/:id/players/:name/inventory/edit   editable inventory + ender chest (version tag included)
PUT    /api/servers/:id/players/:name/inventory/edit   {"version","inventory":[{slot,id,count,damage,name,enchants,from}],"ender":[…]} offline players only; old file kept
GET    /api/servers/:id/players/:name/skin             skin PNG, fetched and cached by the panel (Java and Bedrock)
POST   /api/servers/:id/worlds/inspect                 {"path"} what is inside an uploaded world zip / .mcworld
POST   /api/servers/:id/worlds/convert                 {"path","name","layout":"split|single","use","replace"} import it (server stopped)
GET    /api/servers/:id/luckperms                      is LuckPerms installed
GET    /api/servers/:id/luckperms/data                 groups, users, tracks via `lp export` (server running)
POST   /api/servers/:id/luckperms/action               {"action":"permission.set|group.create|weight.set|parent.add|prefix.set|meta.set|…",…}
GET    /api/servers/:id/jvm                            JVM flag presets for this server's memory
PUT    /api/servers/:id/jvm                            {"preset"|"custom"} sets JAVA_ARGS (admins)
GET    /api/settings/oidc                OpenID Connect settings (admins; the secret is never returned)
PUT    /api/settings/oidc                {"issuer","clientId","clientSecret","label","scopes","ssoOnly":[ids]} or {"clear":true}
POST   /api/settings/oidc/test           check the provider's discovery document and keys
GET    /api/settings/ip-allowlist        list, roles, "yourIp", accounts (admins)
PUT    /api/settings/ip-allowlist        {"enabled","cidrs":[],"roles":["admin","user"]} (refused if it would lock you out)
PUT    /api/settings/ip-allowlist/accounts/:id  {"allowedIps":[]} one account's own list
GET    /api/security/flood               flood blocking state: servers, settings, blocked addresses (admins)
PUT    /api/security/flood               {"maxConnections","maxPackets","blockMinutes","allow":[]}
PUT    /api/security/flood/servers/:id   {"enabled":true} turn it on for one server
POST   /api/security/flood/blocks        {"ip","serverId","minutes"} block by hand
DELETE /api/security/flood/blocks/:id    unblock
GET    /api/security/backup-tests        weekly switch and result history (admins)
PUT    /api/security/backup-tests        {"weekly":true}
POST   /api/security/backup-tests/run    {"serverId","backup"?} test-restore a backup now
POST   /api/auth/passkeys/options        {"password","kind":"platform"|"security-key"|"any"} start adding a passkey
GET    /api/system                       host metrics
GET    /api/system/capacity              memory, CPU, disk per machine and per server (admins)
GET    /api/system/runtime               Docker status
GET    /api/system/update                pending panel updates
POST   /api/system/update                update and restart
GET    /api/system/update/history        applied updates and the rollback target (admins)
POST   /api/system/update/rollback       go back to the version before the last update (admins)
PUT    /api/system/update/auto-check     {"enabled"} six-hourly update check (admins)
GET    /api/system/host-health           SMART, temperatures, OS updates, forecast, uptime (admins; ?refresh=1)
GET    /api/system/host-power            status of a host restart/shutdown (admins)
POST   /api/system/host-power/plan       {"action":"reboot|shutdown"} dry run (admins)
POST   /api/system/host-power            {"action","seconds"} start the countdown (admins)
DELETE /api/system/host-power            cancel it (admins)
GET    /api/system/arch                  CPU architecture, box64/box86 (admins)
POST   /api/system/arch/box64            {"confirm":true} install box64 with apt (admins)
GET    /api/settings/log-rules           global log rules (admins); PUT saves; POST .../run {"dryRun"}
GET    /api/servers/:id/storage          disk breakdown per folder, biggest files, bandwidth (files)
GET    /api/servers/:id/log-rules        per-server rules; PUT saves; POST .../run {"dryRun"}
POST   /api/servers/:id/backups/vault/check      {"deep"} check incremental backups
POST   /api/servers/:id/backups/vault/compact    free unused pieces
POST   /api/servers/:id/backups/vault/retention  {"keepLast","keepDays","dryRun"} remove old incremental backups
```

`WS /ws` streams `servers`, `stats`, `system`, `server:status`, `notification` and `console:<id>`.

## Community

```
GET    /api/leaderboards?game=&metric=          top players across your servers
PUT    /api/servers/:id/community-messages      {"welcome":{enabled,message,mode},"motd":{enabled,messages,everyMinutes,order}}
GET/PUT /api/community/settings                 {"showFeed","showBoards"} (admins)
GET/PUT /api/portal/settings                    {"enabled"} (admins)
GET    /api/public/status/:slug/leaderboards    public leaderboard (rate limited)
GET    /api/portal/config                       public: portal state and sign-in buttons
GET    /api/portal/auth/:provider/start         public: steam or discord sign-in for players
POST   /api/portal/code                         public: {"name"} get a chat code (name sign-in), or none when signed in to add a name
GET    /api/portal/code/:ticket                 public: waiting / verified / expired
GET    /api/portal/me                           player session: own stats, bans, accounts
DELETE /api/portal/names/:server/:name          player session: unlink a name
POST   /api/portal/logout
GET    /api/auth/oauth/steam/start|callback     Steam OpenID sign-in or link (like the other providers)
```
## Getting started checklist

Per account: every signed-in user reads and changes only their own progress.

- `GET /api/onboarding` returns `{ items: [{ id, label, hint, link, done, auto, skipped }], hidden, tourDone, newsId, newsSeen }`. Only steps the account can use are listed.
- `PUT /api/onboarding` takes any of `{ id, done }` (tick or untick one step), `hidden`, `tourDone`, `seenNews`.
- `POST /api/onboarding/reset` clears the account's progress.
## Notifications, reports, extensions

```
GET    /api/notify-prefs?endpoint=       categories, servers and the muted lists (device list if the endpoint has one)
PUT    /api/notify-prefs                 {"mutedCategories":[],"mutedServers":[],"endpoint"?,"reset"?}
POST   /api/notify-actions/run           {"token"} one-time signed button token from a notification; rate limited, audited
GET    /api/reports                      admin: saved reports, auto setting
PUT    /api/reports/settings             admin: {"auto":true}
POST   /api/reports/generate             admin: {"month":"2026-09"} saves data/reports/uptime-2026-09.pdf
GET    /api/reports/uptime.pdf           admin: ?month=2026-09[&server=id] the PDF
GET    /api/reports/file/:name           admin: a saved report
GET    /api/extensions/active            themes, pages and widgets this account can use, and its selected theme
PUT    /api/account/theme                {"theme":"theme-nord/nord"} ("" for none)
GET    /api/extensions                   admin: installed extensions
PUT    /api/extensions/:name             admin: {"enabled":true}
DELETE /api/extensions/:name             admin: remove an installed one
PUT    /api/extensions/settings          admin: {"allowCode":false}
POST   /api/extensions/install-url       admin: {"url":"https://…zip"}
POST   /api/extensions/install-zip       admin: raw .zip body
GET    /ext/<name>/<file>                files of an enabled extension (sandboxed, public)
```
