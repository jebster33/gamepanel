'use strict';

/**
 * Turn two-factor sign-in off for one account, for when its phone and its
 * recovery codes are both gone:
 *
 *   Linux:    sudo systemctl stop gamepanel && sudo node /opt/gamepanel/server/reset-2fa.js <username> && sudo systemctl start gamepanel
 *   Windows (admin PowerShell):
 *     Stop-Service GamePanel; $env:GP_SERVICE = 1
 *     & "$env:ProgramFiles\GamePanel\node\node.exe" "$env:ProgramFiles\GamePanel\server\reset-2fa.js" <username>
 *     Start-Service GamePanel
 *
 * The panel must be stopped first, or it writes its own copy back over this change.
 */

const { config } = require('./core/config');
const { Store } = require('./core/store');

const username = process.argv[2];
if (!username) {
  console.error('Usage: node server/reset-2fa.js <username>');
  process.exit(1);
}
const store = new Store(config.stateFile);
const user = store.state.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
if (!user) {
  console.error(`No account called "${username}" in ${config.stateFile}`);
  process.exit(1);
}
delete user.totp;
delete user.totpPending;
store.saveNow();
console.log(`Two-factor sign-in is off for ${user.username}. Start the panel and sign in with the password.`);
