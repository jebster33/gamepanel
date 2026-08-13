#!/usr/bin/env bash
#
# GamePanel installer for Ubuntu / Debian.
#
#   curl -fsSL https://raw.githubusercontent.com/jebster33/gamepanel/main/install.sh | sudo bash
#
# Re-running the script updates an existing installation in place.

set -euo pipefail

REPO_URL="${GP_REPO_URL:-https://github.com/jebster33/gamepanel.git}"
BRANCH="${GP_BRANCH:-main}"
INSTALL_DIR="${GP_INSTALL_DIR:-/opt/gamepanel}"
DATA_DIR="${GP_DATA_DIR:-/var/lib/gamepanel}"
SERVICE_USER="${GP_USER:-gamepanel}"
PANEL_PORT="${GP_PORT:-8080}"
NODE_MAJOR=20

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'

info()  { printf '%s==>%s %s\n' "$CYAN" "$RESET" "$*"; }
ok()    { printf '%s ✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn()  { printf '%s ! %s%s\n' "$YELLOW" "$*" "$RESET"; }
die()   { printf '%s ✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Please run as root:  curl -fsSL <url> | sudo bash"

command -v apt-get >/dev/null 2>&1 || die "This installer targets Ubuntu/Debian (apt-get was not found)."

printf '\n%s  GamePanel installer%s\n\n' "$BOLD" "$RESET"

# --------------------------------------------------------------- packages --

info "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  curl ca-certificates git tar gzip unzip xz-utils sudo procps >/dev/null
ok "Base packages ready"

# ------------------------------------------------------------------- node --

need_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$current" -ge 18 ] 2>/dev/null; then
    need_node=0
    ok "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) is too old (need >= 18), installing $NODE_MAJOR.x"
  fi
fi

if [ "$need_node" = "1" ]; then
  info "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 || \
    die "NodeSource setup failed. Install Node.js 18+ manually and re-run."
  apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node -v) installed"
fi

# ----------------------------------------------------------------- docker --

# Containers are what keep game servers from interfering with each other.
# The panel still works without Docker, just without isolation.
if [ "${GP_SKIP_DOCKER:-0}" = "1" ]; then
  warn "Skipping Docker installation (GP_SKIP_DOCKER=1) — servers will run as plain processes"
elif command -v docker >/dev/null 2>&1; then
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) already installed"
else
  info "Installing Docker Engine (used to isolate each game server)"
  if curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    ok "Docker installed"
  else
    warn "Docker could not be installed automatically — the panel will fall back to plain processes"
  fi
fi

# ------------------------------------------------------------------- user --

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "Creating service user '$SERVICE_USER'"
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /bin/bash "$SERVICE_USER"
  ok "User created"
else
  ok "User '$SERVICE_USER' already exists"
fi

# Talking to the Docker socket requires membership of the docker group.
# Note: that is equivalent to root on this host — see the README's security
# section before giving anyone else access to the panel user.
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$SERVICE_USER"
  ok "Added '$SERVICE_USER' to the docker group"
fi

# ------------------------------------------------------------------- code --

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating GamePanel in $INSTALL_DIR"
  # The checkout belongs to the service user, and git refuses to operate on a
  # repository owned by someone else — so run git as its owner, not as root.
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
  as_owner() { sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" "$@"; }
  as_owner fetch --quiet origin "$BRANCH"
  as_owner reset --quiet --hard "origin/$BRANCH"
  ok "Updated to $(as_owner rev-parse --short HEAD)"
elif [ -f "$(dirname "$(readlink -f "$0")")/server/index.js" ]; then
  # Running from a checkout — install from these files instead of cloning.
  SRC="$(dirname "$(readlink -f "$0")")"
  info "Installing from local checkout $SRC"
  mkdir -p "$INSTALL_DIR"
  cp -r "$SRC/." "$INSTALL_DIR/"
  ok "Files copied to $INSTALL_DIR"
else
  info "Cloning $REPO_URL"
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
    || die "Could not clone the repository"
  ok "Cloned to $INSTALL_DIR"
fi

# --------------------------------------------------------------- data dir --

# Belt and braces: the exec bit is set in git, but repair it anyway so an
# older checkout (or a copy over a filesystem that drops modes) still works.
chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true

info "Preparing data directory $DATA_DIR"
mkdir -p "$DATA_DIR"/{servers,backups,logs,cache,templates,run}
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$DATA_DIR"
ok "Data directory ready"

# ----------------------------------------------------------------- sudoers --

# Game installers need packages (Java, 32-bit libs, unzip…). Rather than running
# the panel as root, the service user gets a narrow rule for apt-get only.
info "Granting '$SERVICE_USER' passwordless apt-get for game dependencies"
cat > /etc/sudoers.d/gamepanel <<EOF
# Installed by the GamePanel installer.
# Lets the panel install game runtime dependencies without running as root,
# and restart itself when you apply an update from the web UI.
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/dpkg, /usr/bin/systemctl restart gamepanel, /bin/systemctl restart gamepanel
EOF
chmod 440 /etc/sudoers.d/gamepanel
visudo -cf /etc/sudoers.d/gamepanel >/dev/null || { rm -f /etc/sudoers.d/gamepanel; warn "sudoers rule rejected — dependency installs will need manual apt"; }
ok "sudo rule installed"

# 32-bit libraries are needed by SteamCMD and many Source-engine servers.
info "Enabling i386 architecture for SteamCMD"
dpkg --add-architecture i386 >/dev/null 2>&1 || true
apt-get update -qq || true
apt-get install -y -qq --no-install-recommends lib32gcc-s1 lib32stdc++6 >/dev/null 2>&1 \
  && ok "SteamCMD runtime libraries installed" \
  || warn "Could not preinstall 32-bit libraries — SteamCMD templates will retry at install time"

# ----------------------------------------------------------------- systemd --

info "Installing systemd service"
cat > /etc/systemd/system/gamepanel.service <<EOF
[Unit]
Description=GamePanel — game server hosting control panel
Documentation=https://github.com/jebster33/gamepanel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=GP_DATA_DIR=$DATA_DIR
Environment=GP_PORT=$PANEL_PORT
ExecStart=$(command -v node) $INSTALL_DIR/server/index.js
Restart=always
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=120
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal

# Game servers are spawned as children of this unit; they must survive
# individual restarts of a game process but die with the panel.
Delegate=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet gamepanel
systemctl restart gamepanel
ok "Service installed and started"

# ----------------------------------------------------------------- firewall --

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Opening firewall ports"
  ufw allow "$PANEL_PORT"/tcp >/dev/null 2>&1 || true
  ufw allow 27000:27999/tcp >/dev/null 2>&1 || true
  ufw allow 27000:27999/udp >/dev/null 2>&1 || true
  ufw allow 25565:25575/tcp >/dev/null 2>&1 || true
  ok "ufw rules added for the panel and the default game port range"
else
  warn "ufw is not active — make sure your provider's firewall allows port $PANEL_PORT and your game ports"
fi

# ------------------------------------------------------------------- done --

sleep 2
if ! systemctl is-active --quiet gamepanel; then
  warn "The service is not running. Recent logs:"
  journalctl -u gamepanel -n 30 --no-pager || true
  die "GamePanel failed to start"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${IP:-}" ] || IP="localhost"

cat <<EOF

${GREEN}${BOLD}GamePanel is running.${RESET}

  Open        ${BOLD}http://${IP}:${PANEL_PORT}${RESET}
  First run   create your administrator account in the browser

  Install dir $INSTALL_DIR
  Data dir    $DATA_DIR
  Service     systemctl {status,restart,stop} gamepanel
  Logs        journalctl -u gamepanel -f

EOF
