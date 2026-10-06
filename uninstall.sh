#!/usr/bin/env bash
# Removes GamePanel and everything it created: the service, the program,
# every game server, backup, user account, bridge connection and setting,
# the containers and images it built, and its service account.
#
#   sudo /opt/gamepanel/uninstall.sh              asks before deleting anything
#   sudo /opt/gamepanel/uninstall.sh --yes        no questions (for scripts)
#   sudo /opt/gamepanel/uninstall.sh --keep-data  remove the program, keep servers and settings

set -euo pipefail

INSTALL_DIR="${GP_INSTALL_DIR:-/opt/gamepanel}"
DATA_DIR="${GP_DATA_DIR:-/var/lib/gamepanel}"
SERVICE_USER="${GP_USER:-gamepanel}"
KEEP_DATA=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=1 ;;
    -y|--yes) YES=1 ;;
    --purge) ;; # the old flag; removing everything is now the default
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "Run as root: sudo $0" >&2; exit 1; }

if [ "$YES" != "1" ]; then
  echo
  if [ "$KEEP_DATA" = "1" ]; then
    echo "This removes the GamePanel program and service. Servers and settings in $DATA_DIR are kept."
  else
    echo "This removes GamePanel and ALL of its data:"
    echo "  - every game server and its world files, and all backups"
    echo "  - panel users, bridge connections and settings"
    echo "  - the containers and images GamePanel built"
    echo "  - the program in $INSTALL_DIR and the '$SERVICE_USER' account"
  fi
  if [ -r /dev/tty ]; then
    printf 'Type YES to continue: '
    read -r answer </dev/tty || answer=""
  else
    echo "No terminal to confirm on. Re-run with --yes to uninstall without asking." >&2
    exit 1
  fi
  [ "$answer" = "YES" ] || { echo "Cancelled."; exit 1; }
fi

echo "==> Stopping the service"
systemctl disable --now gamepanel 2>/dev/null || true
rm -f /etc/systemd/system/gamepanel.service
systemctl daemon-reload 2>/dev/null || true

# Servers running as plain processes belong to the service user.
pkill -u "$SERVICE_USER" 2>/dev/null || true

if [ "$KEEP_DATA" != "1" ] && command -v docker >/dev/null 2>&1; then
  echo "==> Removing GamePanel containers and images"
  ids="$(docker ps -aq --filter label=gamepanel.managed=true 2>/dev/null || true)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  images="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^gamepanel/' || true)"
  [ -n "$images" ] && docker rmi -f $images >/dev/null 2>&1 || true
fi

echo "==> Removing the program"
rm -rf "$INSTALL_DIR"
rm -f /etc/sudoers.d/gamepanel

if [ "$KEEP_DATA" = "1" ]; then
  echo
  echo "GamePanel removed. Your servers and settings are still in $DATA_DIR"
  exit 0
fi

echo "==> Removing all data in $DATA_DIR"
rm -rf "$DATA_DIR"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  pkill -9 -u "$SERVICE_USER" 2>/dev/null || true
  userdel "$SERVICE_USER" 2>/dev/null || true
fi
echo
echo "GamePanel and all of its data have been removed."
