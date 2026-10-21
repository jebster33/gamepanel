# Install on Proxmox

Two choices. Not tested on a live Proxmox host.

## A Debian container (LXC), scripted

[`docs/install/proxmox-lxc.sh`](../install/proxmox-lxc.sh) creates a Debian 12 container and runs the normal Linux installer inside it. On the Proxmox host, as root (the node's Shell in the web UI is fine):

```bash
curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/docs/install/proxmox-lxc.sh -o proxmox-lxc.sh
less proxmox-lxc.sh        # read it first
bash proxmox-lxc.sh
```

Options go in front: `CTID=210 STORAGE=local-zfs DISK=60 MEMORY=8192 CORES=4 NET=ip=192.168.1.50/24,gw=192.168.1.1 bash proxmox-lxc.sh`.

What it does: downloads the Debian 12 template if needed, runs `pct create` for an unprivileged container with `nesting=1,keyctl=1` (Docker inside a container needs both), starts it, then runs GamePanel's `install.sh` as root inside the container (Node.js, Docker, a service account, a systemd service). When it ends it prints the address to open.

If Docker will not start inside the container, check Options, Features on the container in Proxmox (nesting and keyctl ticked) and reboot the container. Run the container on fast storage; game worlds are write-heavy.

## A virtual machine

If you would rather have full isolation, create a Debian or Ubuntu VM and follow [Install on Linux](install-linux.md).

Either way, forward or tunnel the game ports as usual: [Letting people in without port forwarding](hosting-without-port-forwarding.md).
