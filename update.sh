#!/usr/bin/env bash
# Update GamePanel from the command line. The web UI can do this too
# (Settings → Panel updates); both are equivalent.
#
#   sudo /opt/gamepanel/update.sh

set -euo pipefail

INSTALL_DIR="${GP_INSTALL_DIR:-/opt/gamepanel}"
BRANCH="${GP_BRANCH:-main}"
SERVICE_USER="${GP_USER:-gamepanel}"

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'

[ -d "$INSTALL_DIR/.git" ] || { echo "No git checkout at $INSTALL_DIR — re-run install.sh instead." >&2; exit 1; }

echo "==> Fetching the latest version"
sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" fetch origin "$BRANCH"

BEFORE="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
AFTER="$(git -C "$INSTALL_DIR" rev-parse --short "origin/$BRANCH")"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "${GREEN}Already up to date ($BEFORE).${RESET}"
  exit 0
fi

echo "==> Updating $BEFORE -> $AFTER"
git -C "$INSTALL_DIR" log --oneline "HEAD..origin/$BRANCH" | sed 's/^/    /'
sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"

echo "==> Restarting the panel"
# Game servers running in containers are not touched by this; the panel
# re-attaches to them once it is back up.
systemctl restart gamepanel

sleep 2
if systemctl is-active --quiet gamepanel; then
  echo "${GREEN}Updated to $AFTER and running.${RESET}"
else
  echo "${YELLOW}The panel did not come back up. Check: journalctl -u gamepanel -n 50${RESET}" >&2
  exit 1
fi
