# Extensions

Extensions are small add-ons an administrator installs into the panel. They can add **colour themes**, **extra pages** in the sidebar, **dashboard widgets**, and **webhooks** that fire when something happens. Manage them in **Settings, Extensions** (list, turn on/off, install from a `.zip` or a link, remove).

## Trust, in plain words

Installing an extension means you trust whoever wrote it.

| Kind | What it can do | Safe by default? |
| --- | --- | --- |
| Theme | Change colours (CSS variables) and optionally add a CSS file. | Yes. Values are checked: no `url()`, `@import`, or anything that breaks out of a declaration. |
| Page / widget | Show its own HTML in a sandboxed iframe (no cookies, no network, no access to the panel). It can only call a small read-only API through `postMessage`, and only the parts its manifest asks for. | Yes |
| Webhook (hook) | The panel itself sends an HTTP POST to the URL in the manifest when a matching event happens (crash, backup failed...). | Mostly: the event text goes to that URL, so only install hooks you trust. |
| Code (`main`) | A Node.js file that runs **inside the panel** with full access to it. | **No.** Off unless an administrator ticks **Allow code extensions** in Settings. Takes effect after a restart. |

Built-in themes ship in the repo's `extensions/` folder and can be turned off but not removed. Installed ones live in `data/extensions/<name>/`.

## Picking a theme

Everyone can pick a theme under **Account, Appearance**. It is saved on your account and applied before the page paints (no flash). The sun/moon button in the top bar returns to the plain dark or light look.

Built in: Control room (default), Midnight blue, Solarized dark, Solarized light, Dracula, Nord, Rust orange, Forest green, High contrast, Paper light.

## Manifest format

A package is a folder (or `.zip`) with a `manifest.json` at the top and the files it names. Allowed file types: `.html .js .css .json .svg .png .jpg .webp .gif .woff2 .txt .md .ico`. A zip is limited to 500 files and 20 MB and may not contain absolute paths, `..`, or links.

```json
{
  "name": "hello-ext",
  "title": "Hello extension",
  "version": "1.0.0",
  "author": "You",
  "description": "A theme, a page and a widget.",
  "api": ["servers"],
  "themes": [
    { "id": "ocean", "name": "Ocean", "mode": "dark",
      "vars": { "--bg": "#08141f", "--surface": "#0d2233", "--lime": "#35b7ff", "--lime-ink": "#031018", "--lime-text": "#35b7ff" },
      "css": "ocean.css" }
  ],
  "pages":   [ { "id": "overview", "title": "Overview", "entry": "page.html", "adminOnly": true } ],
  "widgets": [ { "id": "count", "title": "Servers", "entry": "widget.html", "height": 120 } ],
  "hooks":   [ { "event": "server.crashed", "url": "https://example.com/hook" } ],
  "main": "server.js"
}
```

* `name`: 2-40 characters, lowercase letters, digits, dashes. Must match the folder name.
* `themes[].mode`: `dark` or `light`, the base your variables sit on. `vars` are CSS variables such as `--bg --sidebar --surface --raised --hover --border --border-strong --inset --text --muted --faint --lime --lime-ink --lime-text --lime-soft --lime-glow --amber --red --blue` (see the top of `public/css/style.css`). Anything you leave out comes from the base.
* `pages` / `widgets`: `entry` is an `.html` file. `adminOnly` defaults to true; set `false` to show it to every account. Widgets appear on the Dashboard.
* `api`: which read-only bridge groups the pages may use: `servers`, `host`.
* `hooks[].event`: `server.crashed`, `backup.*` (prefix), or `*`. The POST body is `{event, message, serverId, at, extension}`. At most 30 per minute per hook.
* `main`: a code extension (see above). Exports `activate(api)`; `api.on('server.crashed', fn)`, `api.log(text)`, `api.servers()`.

### Page and widget API

Include the helper and call methods; each returns a promise.

```html
<script src="/js/ext-sdk.js"></script>
<script>
  gamepanel.call('servers.list').then(r => { document.body.textContent = r.servers.length + ' servers'; });
</script>
```

Methods: `theme.get`, `user.me` (always), `servers.list` and `server.get {id}` (need `"servers"`), `host.get` (needs `"host"`). The panel's colours are set on the page as CSS variables (`var(--bg)`, `var(--text)`...), and `gamepanel.onTheme` is called when they arrive.

## Installing

* **Zip upload or link:** Settings, Extensions. A link must be `https://`; a GitHub repository address downloads its main branch.
* **By hand:** copy the folder to `data/extensions/<name>/` and reload Settings.
