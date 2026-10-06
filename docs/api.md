# HTTP API

Everything the UI does is a REST call. Authenticate with the session cookie, `Authorization: Bearer <token>` from `POST /api/auth/login`, or an API key.

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
GET    /api/servers/:id/activity         joins, leaves, chat, kicks (?types=&q=&before=)
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
PUT    /api/servers/:id/subdomain        {"name"} Cloudflare A (+ SRV) record (admins)
POST   /api/players/ban-everywhere       {"name","reason","unban?"} every Minecraft server
GET    /api/players/search?q=            players on any visible server (admins: also by address)
PUT    /api/servers/:id/maintenance      {"enabled","message?"} whitelist on, kick non-ops, MOTD
PUT    /api/players/:name/note           {"note","watch"} staff note; watch = alert on join
GET    /api/servers/:id/export           whole server as .tar.gz with gamepanel-server.json (admins)
GET    /api/servers/:id/diagnose         crash doctor findings
POST   /api/servers/:id/share-log        upload the console to mclo.gs
GET    /api/system                       host metrics
GET    /api/system/runtime               Docker status
GET    /api/system/update                pending panel updates
POST   /api/system/update                update and restart
```

`WS /ws` streams `servers`, `stats`, `system`, `server:status` and `console:<id>`.
