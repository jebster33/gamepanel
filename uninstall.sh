#!/usr/bin/env bash
# Removes GamePanel. Game server files in the data directory are kept unless
# you pass --purge.

set -euo pipefail

INSTALL_DIR="${GP_INSTALL_DIR:-/opt/gamepanel}"
DATA_DIR="${GP_DATA_DIR:-/var/lib/gamepanel}"
SERVICE_USER="${GP_USER:-gamepanel}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" = "0" ] || { echo "Run as root" >&2; exit 1; }

echo "==> Stopping the service"
systemctl disable --now gamepanel 2>/dev/null || true
rm -f /etc/systemd/system/gamepanel.service
systemctl daemon-reload

echo "==> Removing panel files"
rm -rf "$INSTALL_DIR"
rm -f /etc/sudoers.d/gamepanel

if [ "$PURGE" = "1" ]; then
  echo "==> Purging data directory $DATA_DIR (all game servers and backups)"
  rm -rf "$DATA_DIR"
  userdel "$SERVICE_USER" 2>/dev/null || true
  echo "GamePanel and all game data removed."
else
  echo
  echo "GamePanel removed. Your game servers are still in $DATA_DIR"
  echo "Run '$0 --purge' to delete them too."
fi
