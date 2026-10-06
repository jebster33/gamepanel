# GamePanel Bridge

Let people play on your servers without opening a port for every game. Like a
small private VPN for your panel: each person runs a personal client, and the
servers you share with them appear on their own computer at `127.0.0.1`.

## Setting it up

1. **Settings → GamePanel Bridge → Turn on.** A **Connections** page appears.
2. On **Connections**, check **Public address clients connect to**. It is the
   address people outside your network use to reach the panel, such as
   `http://203.0.113.5:8420` or `https://panel.example.com`. The panel's own port
   is the only one that has to be reachable. **Open port … on this machine and the
   router** does that for you over UPnP when your router supports it.
3. **Add connection**: type a username and tick the servers they may reach.
4. Download their client (**Windows**, or **Linux**) and send it to them. Each
   download only works for that one account.

They run it. The first time it asks them to choose a password; after that it
remembers them on that computer. The window lists an address for each shared
port, like `Minecraft  127.0.0.1:25565`, and they connect their game to it.

## Managing a connection

| Action | What happens |
|---|---|
| Tick or untick servers | Their client opens or closes those ports within seconds. |
| Extra ports | Anything else: SSH (`22`), a web map, a voice server. *Local port* is what they use on their computer, *Host* is where the panel sends it (blank = the panel's machine). |
| Turn off | Disconnects them now; switching it back on lets them back in. |
| Reset password | Disconnects and signs them out. The next time they open the client it asks for a new password. |
| Revoke old downloads | Every copy sent so far stops working. Download a fresh one for them. |
| Sign out a device | That computer has to sign in with the password again. |

## How it works, and why it is safe

- Clients connect to the panel's normal address with a WebSocket, so the bridge
  passes through anything the dashboard passes through: a reverse proxy, a
  domain, Cloudflare Tunnel.
- Inside that WebSocket runs **TLS 1.3, pinned to the panel's own key**. The key is
  made when the bridge is first turned on (`bridge/identity.json` in the data
  folder) and its fingerprint is written into every download. A client refuses
  anything else, so the tunnel is encrypted and authenticated even when the panel
  itself is plain `http://`, and nobody in between can read or impersonate it.
- Every download also carries a key derived from the panel's secret and that
  connection. Without a current download, nothing gets past the first message.
- Passwords are hashed with scrypt, like panel passwords, and never stored in
  clear. Clients keep a random device token (the panel stores only its SHA-256),
  encrypted with Windows DPAPI on Windows and readable only by the user elsewhere.
- Failed sign-ins are rate limited per address and per account.
- The panel forwards only to the exact ports a connection was given. Nothing else
  on the machine or network is reachable through it.

## Uninstalling the client

Type `uninstall` in the client window (or run it with `--uninstall`). It signs
the device out, removes everything it saved and deletes itself.

## Troubleshooting

| Message | Meaning |
|---|---|
| Can't reach the panel at … | The public address is wrong or the panel's port is not reachable from where they are. |
| The panel's identity does not match this download | The panel was reinstalled (new key), or something is intercepting the connection. Send a new download. |
| This copy of GamePanel Bridge is no longer valid | The connection was deleted or its downloads were revoked. Send a new download. |
| Port 25565 was busy on this computer | Something else already uses that port on their machine; the client picked another one and shows it. |

## For developers

The client is Go with no dependencies, in `bridge/client`. The
`Bridge client` workflow builds it for Windows and Linux, runs
`test/bridge-e2e.js` against a real panel on both, and publishes the binaries as
the `bridge-v<version>` release (version in `package.json` →
`bridgeClientVersion`). Panels download the binary for that version once and
append a small trailer per connection. An offline panel can use a copy placed in
`<data>/bridge/bin/v<version>/`.
