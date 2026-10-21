#!/usr/bin/env bash
#
# Create a Debian LXC container on a Proxmox VE host and install GamePanel in it.
# Run this on the Proxmox host as root (the node's Shell in the web UI is fine):
#
#   bash proxmox-lxc.sh                       # asks nothing, uses the defaults below
#   CTID=210 STORAGE=local-zfs MEMORY=8192 CORES=4 DISK=60 bash proxmox-lxc.sh
#
# What it does, in order (nothing else is touched):
#   1. downloads the Debian 12 container template if the host has none
#   2. pct create: an unprivileged container with nesting and keyctl turned on
#      (Docker inside a container needs both)
#   3. starts it and runs GamePanel's install.sh inside it
#
# Not tested on a live Proxmox host.

set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME_="${CT_HOSTNAME:-gamepanel}"
STORAGE="${STORAGE:-local-lvm}"          # where the container disk goes
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK="${DISK:-40}"                        # GB
MEMORY="${MEMORY:-4096}"                  # MB
CORES="${CORES:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-ip=dhcp}"                     # e.g. ip=192.168.1.50/24,gw=192.168.1.1
INSTALL_URL="${INSTALL_URL:-https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh}"

die() { printf '\033[31m x %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "Run as root on the Proxmox host."
command -v pct >/dev/null 2>&1 || die "pct not found: this script is for a Proxmox VE host."
case "$CTID" in ''|*[!0-9]*) die "CTID must be a number." ;; esac
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists. Pick another with CTID=…"

info "Looking for a Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -n1)"
[ -n "$TEMPLATE" ] || die "No Debian 12 template is listed by pveam."
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  info "Downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

info "Creating container $CTID ($HOSTNAME_)"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_" \
  --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,$NET" \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 \
  --onboot 1 \
  --start 1

info "Waiting for the container network"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

info "Installing GamePanel inside it (this runs install.sh from $INSTALL_URL as root in the container: Node.js, Docker, a service account, a systemd service)"
pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && curl -fsSL '$INSTALL_URL' | bash"

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n\033[32m GamePanel is installed.\033[0m Open http://%s:8420 and create your admin account.\n' "${IP:-<container ip>}"
