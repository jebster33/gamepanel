# Letting people in without port forwarding

Home routers often cannot, or will not, forward ports. GamePanel has four ways around that. Settings has a **Connection wizard** that tests your network and recommends one, in this order:

1. **Port forwarding**: the direct way. See [Making a server reachable](../troubleshooting.md#making-a-server-reachable).
2. **[GamePanel Bridge](../bridge.md)**: friends run a small client and your servers appear on their computer.
3. **playit.gg**: a free tunnel service. Players need nothing installed.
4. **Tailscale or ZeroTier**: a private network that you and your players join. Everyone needs the app.

All of these are administrator-only and live under **Settings**.

## The wizard

Settings, **Connection wizard**. Optionally pick a running server, then press **Check and recommend**. It asks an outside service whether the server answers from the internet, looks for a UPnP router, and notices when your internet provider shares one public address between customers (CGNAT, where port forwarding can never work). Each way comes with plain steps.

## playit.gg

What it is: playit.gg gives each of your game ports a public address. A small program (the agent) on this machine carries the traffic out to playit.gg, so no router settings are needed.

1. Settings, **playit.gg tunnel**, **Install agent**. The panel downloads the agent for your system from the official GitHub releases (`playit-cloud/playit-agent`) and checks its size, that it is a real program, and its SHA-256 when GitHub lists one.
2. **Start**. The first time, a link and code appear. Open the link and sign in (or sign up) at playit.gg to approve this machine. The panel keeps the agent's secret encrypted in its settings, never in the page.
3. On playit.gg, **Add tunnel** for each server port, with the local address `127.0.0.1` and the port shown in the table. The public address then appears next to the server; use **Copy** and share it.
4. Tick **Start with the panel** to bring the agent up whenever the panel starts. **Unlink this machine** forgets the login (tunnels stay on playit.gg).

Not tested live against playit.gg: if the agent's command line or API changes, the log under **Agent log** shows what it said.

## Tailscale and ZeroTier

Use these when the bridge does not work for you. The panel shows whether each is installed and connected, this machine's private addresses and, per server, ready-to-copy connect addresses such as `100.64.0.5:25565`.

- **Tailscale**: create an auth key in the Tailscale admin console (Settings, Keys), paste it and press **Connect**. Players install Tailscale and join your tailnet (invite them, or share this machine with them), then connect to the address shown.
- **ZeroTier**: paste your 16-character network id (my.zerotier.com), press **Join network**, and tick the machine's Auth box in ZeroTier Central. Players join the same network id and connect to the address shown.

**Installing.** On Linux the panel can run the vendors' official installers; before it does it tells you exactly what runs:

- Tailscale: downloads `https://tailscale.com/install.sh` and runs it with `sh` as root.
- ZeroTier: downloads `https://install.zerotier.com` and runs it with `bash` as root.

That needs the panel to be allowed to use `sudo` without a password. If it is not, the panel shows the one-line command to paste into a terminal yourself (`curl -fsSL https://tailscale.com/install.sh | sh`, or `curl -s https://install.zerotier.com | sudo bash`). On Windows and macOS install the app from tailscale.com/download or zerotier.com/download. The panel never passes text you type to a shell: keys and ids are checked first and programs are run with fixed arguments. The Tailscale key is handed over through a short-lived private file, not the command line, and is only kept (encrypted) if you tick **Remember**.

Not tested live against Tailscale or ZeroTier.
