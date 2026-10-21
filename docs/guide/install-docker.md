# Install with Docker

The repository ships a `Dockerfile` and a `docker-compose.yml`. The panel runs in one container and starts each game server as a sibling container through the Docker socket.

```bash
git clone https://github.com/jebster33/gamepanel.git
cd gamepanel
sudo mkdir -p /var/lib/gamepanel
docker compose up -d --build
```

Open **http://&lt;this machine&gt;:8420** and create your admin account ([First setup](first-setup.md)).

## Read this first

- **The Docker socket.** The compose file mounts `/var/run/docker.sock` because that is how the panel starts games. Whoever controls the panel then controls Docker on the host, which is the same as root. Keep admin accounts to people you trust and turn on two-factor sign-in.
- **Same path inside and outside.** The data folder is mounted at the same path on both sides (`/var/lib/gamepanel`). Game containers are started by the host's Docker, which resolves a server folder by its host path. If you change one side, change the other and `GP_DATA_DIR`.
- **Host networking.** `network_mode: host` (Linux) makes every game port work without listing it. On Docker Desktop (Windows, macOS) host networking does not behave the same way: publish the ports you need instead, and expect to open them by hand.
- **No Docker socket?** Remove the mount and the panel runs games as plain processes inside its own container. That works but gives up per-server isolation and limits, and the container only has the tools in the image.
- **Updating:** `git pull && docker compose up -d --build`. Your data folder is untouched.
- This is not a replacement for the normal installer on a dedicated Linux box ([install on Linux](install-linux.md)), which is simpler and gives the firewall integration.

Platform guides built on this: [Unraid](install-unraid.md), [TrueNAS SCALE](install-truenas.md), [Proxmox](install-proxmox.md). None of these were tested on live systems here.
