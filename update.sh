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

# The checkout belongs to the service user. Git refuses to touch a repository
# owned by someone else ("dubious ownership"), so every git command here runs
# as that user — never as root, even though the restart below needs root.
if [ "$(id -un)" = "$SERVICE_USER" ]; then
  git_run() { git -C "$INSTALL_DIR" "$@"; }
elif command -v sudo >/dev/null 2>&1 && id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # Make sure ownership actually matches before handing git over.
  if [ "$(id -u)" = "0" ]; then
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
  fi
  git_run() { sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" "$@"; }
else
  git_run() { git -C "$INSTALL_DIR" "$@"; }
fi

echo "==> Fetching the latest version"
git_run fetch origin "$BRANCH"

BEFORE="$(git_run rev-parse --short HEAD)"
AFTER="$(git_run rev-parse --short "origin/$BRANCH")"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "${GREEN}Already up to date ($BEFORE).${RESET}"
  exit 0
fi

echo "==> Updating $BEFORE -> $AFTER"
git_run log --oneline "HEAD..origin/$BRANCH" | sed 's/^/    /'
git_run reset --hard "origin/$BRANCH"
chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true

echo "==> Restarting the panel"
# Game servers running in containers are not touched by this; the panel
# re-attaches to them once it is back up.
if [ "$(id -u)" = "0" ]; then
  systemctl restart gamepanel
else
  sudo systemctl restart gamepanel
fi

sleep 2
if systemctl is-active --quiet gamepanel; then
  echo "${GREEN}Updated to $AFTER and running.${RESET}"
else
  echo "${YELLOW}The panel did not come back up. Check: journalctl -u gamepanel -n 50${RESET}" >&2
  exit 1
fi
