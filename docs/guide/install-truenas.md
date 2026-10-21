# Install on TrueNAS SCALE

For TrueNAS SCALE 24.10 and newer, which runs apps with Docker. Use the custom app file [`docker/truenas/gamepanel-app.yaml`](../../docker/truenas/gamepanel-app.yaml). Not tested on a live TrueNAS system.

1. **Datasets**, add a dataset for the panel, for example `tank/apps/gamepanel`. Its path is `/mnt/tank/apps/gamepanel`.
2. Edit the file so the three places that mention `/mnt/tank/apps/gamepanel` match your dataset path (the volume on both sides and `GP_DATA_DIR`).
3. **Apps**, **Discover Apps**, **Custom App**, **Install via YAML**, paste the file, **Save**.
4. The image is `ghcr.io/jebster33/gamepanel:latest`. If it is not published yet, build one from the repository's `Dockerfile` on the TrueNAS shell and put its name in the file.
5. Open `http://<truenas-ip>:8420` and create your admin account.

Notes: the file mounts the Docker socket so the panel can start games; that gives it control of Docker on the NAS, so keep admin accounts tight. The data path must be identical inside and outside the container. Older TrueNAS SCALE (Kubernetes based) cannot use this file; run GamePanel in a VM or an LXC on Proxmox instead. See [Install with Docker](install-docker.md).
