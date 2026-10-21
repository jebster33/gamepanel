'use strict';

/**
 * Switch the IP allowlist off (and lift "single sign-on only"), for when it
 * locks everyone out, or the SSO provider is down:
 *
 *   Linux:    sudo systemctl stop gamepanel && sudo node /opt/gamepanel/server/reset-allowlist.js [--accounts] && sudo systemctl start gamepanel
 *   Windows (admin PowerShell):
 *     Stop-Service GamePanel; $env:GP_SERVICE = 1
 *     & "$env:ProgramFiles\GamePanel\node\node.exe" "$env:ProgramFiles\GamePanel\server\reset-allowlist.js" --accounts
 *     Start-Service GamePanel
 *
 * --accounts also clears every account's own allowed-address list.
 * The list itself is kept, so turning it back on later is one click. The panel
 * must be stopped first, or it writes its own copy back over this change.
 */

const { config } = require('./core/config');
const { Store } = require('./core/store');

function main() {
  const store = new Store(config.stateFile);
  require('./features/ip-allowlist').reset(store.state, { accounts: process.argv.includes('--accounts') });
  const oidc = store.state.settings.oauth?.oidc;
  if (oidc) oidc.ssoOnly = [];
  store.saveNow();
  console.log('The IP allowlist is off and no account is limited to single sign-on. Start the panel and sign in.');
}

// Only when run from the command line (the self-check loads every module).
if (require.main === module) main();
