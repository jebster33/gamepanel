# Install on Unraid

GamePanel ships a Community Applications style template: [`docker/unraid/gamepanel.xml`](../../docker/unraid/gamepanel.xml). Not tested on a live Unraid system.

1. Make the image available. The template points at `ghcr.io/jebster33/gamepanel:latest`. If that image is not published yet, build your own on the Unraid terminal and change **Repository** in the template to `gamepanel:local`:

   ```bash
   git clone https://github.com/jebster33/gamepanel.git /tmp/gamepanel && docker build -t gamepanel:local /tmp/gamepanel
   ```

2. Docker tab, **Add Container**, then in **Template** paste or pick the template: copy `gamepanel.xml` to `/boot/config/plugins/dockerMan/templates-user/` on the flash drive, and it appears in the Template list.
3. Check the settings: **Network** host, **Data folder** `/mnt/user/appdata/gamepanel` (the host path and the container path must be the same), the Docker socket path. **Apply**.
4. Open the Web UI link and create your admin account.

Notes: the Docker socket gives the panel control of Docker on your server, so use strong admin passwords and two-factor sign-in. Games started by the panel appear in Unraid's Docker tab as normal containers. Keep the data folder on a cache pool or an array share with enough space; game files can be large. More detail in [Install with Docker](install-docker.md).
