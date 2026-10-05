# HTTP API

Everything the UI does is a REST call. Authenticate with the session cookie or `Authorization: Bearer <token>` from `POST /api/auth/login`.

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
GET    /api/system                       host metrics
GET    /api/system/runtime               Docker status
GET    /api/system/update                pending panel updates
POST   /api/system/update                update and restart
```

`WS /ws` streams `servers`, `stats`, `system`, `server:status` and `console:<id>`.
