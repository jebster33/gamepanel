'use strict';

/**
 * Turns a template's declarative `install` steps into a single bash script.
 *
 * Running one script (rather than orchestrating steps from Node) means the
 * install streams to the live console exactly like a terminal session, and any
 * step can rely on the shell state left by the previous one.
 */

const { interpolate } = require('./util');
const { config } = require('./config');

const PREAMBLE = `#!/usr/bin/env bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME="\${HOME:-$GP_SERVER_DIR}"

gp_log()  { printf '\\n\\033[36m[gamepanel]\\033[0m %s\\n' "$*"; }
gp_warn() { printf '\\n\\033[33m[gamepanel]\\033[0m %s\\n' "$*"; }
gp_die()  { printf '\\n\\033[31m[gamepanel]\\033[0m %s\\n' "$*"; exit 1; }

# Package installs need root. install.sh grants the panel user a narrow
# passwordless sudo rule for apt-get; without it we warn instead of failing so
# a manually-prepared box still installs fine.
gp_sudo() {
  if [ "$(id -u)" = "0" ]; then "$@";
  elif sudo -n true 2>/dev/null; then sudo "$@";
  else return 127; fi
}

gp_apt() {
  command -v apt-get >/dev/null 2>&1 || { gp_warn "apt-get not available, skipping: $*"; return 0; }
  if ! gp_sudo apt-get update -qq; then
    gp_warn "Could not run apt-get (needs root or passwordless sudo). Install manually: $*"
    return 0
  fi
  if ! gp_sudo apt-get install -y -qq --no-install-recommends "$@"; then
    gp_warn "apt-get install failed for: $*"
    return 0
  fi
  gp_log "Installed packages: $*"
}

gp_have() { command -v "$1" >/dev/null 2>&1; }

gp_fetch() {
  local url="$1" dest="$2"
  gp_log "Downloading $url"
  if gp_have curl; then curl -fL --retry 3 --connect-timeout 20 -o "$dest" "$url" || gp_die "Download failed: $url"
  elif gp_have wget; then wget -q -O "$dest" "$url" || gp_die "Download failed: $url"
  else gp_die "Neither curl nor wget is installed"; fi
}

gp_extract() {
  local file="$1" dest="\${2:-.}"
  mkdir -p "$dest"
  gp_log "Extracting $file"
  case "$file" in
    *.tar.gz|*.tgz)  tar -xzf "$file" -C "$dest" ;;
    *.tar.xz)        tar -xJf "$file" -C "$dest" ;;
    *.tar.bz2)       tar -xjf "$file" -C "$dest" ;;
    *.tar)           tar -xf  "$file" -C "$dest" ;;
    *.zip)           gp_have unzip || gp_apt unzip; unzip -oq "$file" -d "$dest" ;;
    *)               gp_die "Do not know how to extract $file" ;;
  esac
}

gp_ensure_java() {
  local want="\${1:-21}"
  if gp_have java; then
    local have
    have="$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\\1/')"
    if [ -n "$have" ] && [ "$have" -ge "$want" ] 2>/dev/null; then
      gp_log "Java $have already present"
      return 0
    fi
  fi
  gp_apt "openjdk-\${want}-jre-headless" || true
  gp_have java || gp_apt default-jre-headless
  gp_have java || gp_die "Java could not be installed automatically. Install a JRE >= $want and reinstall."
}

gp_ensure_steamcmd() {
  if [ ! -x "$GP_STEAMCMD/steamcmd.sh" ]; then
    gp_log "Bootstrapping SteamCMD"
    # 32-bit runtime libs are required by steamcmd itself on 64-bit Ubuntu
    if gp_have dpkg; then gp_sudo dpkg --add-architecture i386 >/dev/null 2>&1 || true; fi
    gp_apt lib32gcc-s1 lib32stdc++6 ca-certificates || true
    mkdir -p "$GP_STEAMCMD"
    gp_fetch "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" "$GP_STEAMCMD/steamcmd.tar.gz"
    tar -xzf "$GP_STEAMCMD/steamcmd.tar.gz" -C "$GP_STEAMCMD" || gp_die "Could not unpack SteamCMD"
    rm -f "$GP_STEAMCMD/steamcmd.tar.gz"
  fi
}

gp_steam_app() {
  local appid="$1" login="\${2:-anonymous}" branch="\${3:-}"
  gp_ensure_steamcmd
  gp_log "Installing Steam app $appid (this can take a while)"
  local args=( +@sSteamCmdForcePlatformBitness 64 +force_install_dir "$GP_SERVER_DIR" +login "$login" )
  if [ -n "$branch" ]; then args+=( +app_update "$appid" -beta "$branch" validate )
  else args+=( +app_update "$appid" validate ); fi
  args+=( +quit )
  "$GP_STEAMCMD/steamcmd.sh" "\${args[@]}" || gp_die "SteamCMD failed for app $appid"
  # SteamCMD ships its own runtime libs; make them discoverable for the server.
  mkdir -p "$GP_SERVER_DIR/.steam/sdk64" "$GP_SERVER_DIR/.steam/sdk32"
  cp -f "$GP_STEAMCMD/linux64/steamclient.so" "$GP_SERVER_DIR/.steam/sdk64/" 2>/dev/null || true
  cp -f "$GP_STEAMCMD/linux32/steamclient.so" "$GP_SERVER_DIR/.steam/sdk32/" 2>/dev/null || true
}

cd "$GP_SERVER_DIR" || gp_die "Server directory is missing"
`;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stepToShell(step, vars) {
  const type = String(step.type || '').toLowerCase();
  const val = (v) => interpolate(v, vars);

  switch (type) {
    case 'apt':
      return `gp_apt ${(step.packages || []).map((p) => shellQuote(val(p))).join(' ')}`;

    case 'java':
      return `gp_ensure_java ${shellQuote(val(step.version || '21'))}`;

    case 'steamcmd':
      return `gp_steam_app ${shellQuote(val(step.appid))} ${shellQuote(val(step.login || 'anonymous'))} ${shellQuote(
        val(step.branch || '')
      )}`;

    case 'download':
      return `gp_fetch ${shellQuote(val(step.url))} ${shellQuote(val(step.dest || 'download.bin'))}`;

    case 'extract':
      return `gp_extract ${shellQuote(val(step.file))} ${shellQuote(val(step.dest || '.'))}${
        step.deleteArchive ? `\nrm -f ${shellQuote(val(step.file))}` : ''
      }`;

    case 'writefile': {
      const content = val(step.content ?? '');
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const dest = shellQuote(val(step.path));
      return `mkdir -p "$(dirname ${dest})"\nprintf '%s' ${shellQuote(b64)} | base64 -d > ${dest}\ngp_log "Wrote ${val(
        step.path
      )}"`;
    }

    case 'chmod':
      return `chmod ${shellQuote(val(step.mode || '+x'))} ${shellQuote(val(step.path))} || true`;

    case 'mkdir':
      return `mkdir -p ${shellQuote(val(step.path))}`;

    case 'script':
      return val(step.run || step.script || '');

    default:
      return `gp_warn ${shellQuote(`Unknown install step type: ${step.type}`)}`;
  }
}

/**
 * @param {object} template
 * @param {Record<string,string|number>} vars fully-resolved template variables
 * @returns {{script:string, env:Record<string,string>}}
 */
function buildInstallScript(template, serverDir, vars) {
  const steps = (template.install || []).map((step, i) => {
    const label = step.label || `${step.type} step ${i + 1}`;
    return `gp_log ${shellQuote(label)}\n${stepToShell(step, vars)}`;
  });

  const script = [
    PREAMBLE,
    ...steps,
    `gp_log "Install complete"`,
    `exit 0`,
  ].join('\n\n');

  const env = {
    GP_SERVER_DIR: serverDir,
    GP_STEAMCMD: config.steamcmdDir,
  };
  for (const [k, v] of Object.entries(vars)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(k)) env[k] = String(v);
  }
  return { script, env };
}

module.exports = { buildInstallScript };
