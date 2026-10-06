import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { openModal } from '../ui/modal.js';
import { otpMarkup, wireOtp } from '../ui/otp.js';
import { qrSvg } from '../ui/qr.js';
import { startTour } from '../ui/tour.js';
import { LANGUAGES, lang, setLanguage } from '../core/i18n.js';

/* --------------------------------------------------------------- account */

/** Your own sign-in: password and two-factor. Open to every account. */
export async function renderAccount(view) {
  setCrumbs('Account');
  const me = await api('/api/auth/me').then((d) => d.user).catch(() => state.user);
  if (state.route.name !== 'account') return; // the user moved to another page meanwhile
  state.user = { ...state.user, ...me };

  view.innerHTML = `
    <div class="page-head"><div><h1>Account</h1><div class="lede">Signed in as <b>${esc(me.username)}</b>${
      me.lastLogin ? ` · last sign-in ${esc(fmtTime(me.lastLogin))}` : ''
    }</div></div></div>

    <div class="card mb-16" id="twofactor">
      <h4>Two-factor sign-in</h4>
      <div id="tf-body"></div>
    </div>

    <div class="card mb-16 row phone-app" style="align-items:center;gap:22px">
      <div class="qr-box">${qrSvg(`${location.origin}/app/`, { size: 132 })}</div>
      <div style="flex:1;min-width:220px">
        <h4 style="margin-top:0">iPhone app</h4>
        <ol class="faint" style="margin:0 0 10px;padding-left:18px;line-height:1.8">
          <li>Scan this with your iPhone camera (or open <a class="mono" href="/app/">${esc(location.host)}/app</a> in Safari).</li>
          <li>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</li>
          <li>Open GamePanel from your home screen and sign in.</li>
        </ol>
        <div class="hint">Works on Android too (Chrome menu, then Install app). Use the panel's HTTPS address if you have one, so it works away from home.</div>
      </div>
    </div>

    <div class="card mb-16">
      <h4>Change your password</h4>
      <div class="form-grid">
        <label><span>Current password</span><input id="a-current" type="password" autocomplete="current-password" /></label>
        <label><span>New password</span><input id="a-new" type="password" autocomplete="new-password" /></label>
      </div>
      <button class="btn mt-16" id="a-save">Update password</button>
      <div class="hint">Changing it signs you out on every other device.</div>
    </div>

    <div id="linked-card"></div>

    <div class="card mb-16" id="prefs">
      <h4>This browser</h4>
      <div class="row mb-16" style="gap:12px;align-items:center">
        <div class="faint" style="flex:1;min-width:220px">Language of the panel in this browser. Server consoles, files and names stay as they are.</div>
        <select id="a-lang" style="width:auto" translate="no">${LANGUAGES.map((l) => `<option value="${l.id}" ${l.id === lang ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
      </div>
      <div class="row" style="gap:12px;align-items:center">
        <div class="faint" style="flex:1;min-width:220px">A quick walk past the main parts of the panel.</div>
        <button class="btn" id="a-tour">Take the tour</button>
      </div>
    </div>

    <div class="card mb-16 row" style="align-items:center;gap:16px">
      <div style="flex:1;min-width:220px">
        <h4 style="margin-top:0">Other devices</h4>
        <div class="faint">Signed in somewhere you shouldn't be, like a friend's computer? End every session except this one.</div>
      </div>
      <button class="btn" id="a-revoke">Sign out other devices</button>
    </div>

    <div class="card mb-16" id="api-keys">
      <h4>API keys</h4>
      <div class="faint" style="margin-bottom:12px">For scripts and Discord bots. Send it as <span class="mono">Authorization: Bearer gp_…</span>. A key can do what your account can, except change accounts. Read-only keys can only look.</div>
      <div id="ak-list"></div>
      <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
        <input id="ak-name" placeholder="What is it for? (e.g. Discord bot)" maxlength="40" style="flex:1;min-width:200px" />
        <label class="checkbox-row" style="margin:0"><input type="checkbox" id="ak-ro" checked /><span>Read-only</span></label>
        <button class="btn" id="ak-create">Create key</button>
      </div>
    </div>`;

  renderTwoFactor(me);
  renderApiKeys();

  $('#a-tour').addEventListener('click', () => startTour());
  $('#a-lang').addEventListener('change', (e) => setLanguage(e.target.value));
  renderLinkedAccounts($('#linked-card'));
  $('#a-revoke').addEventListener('click', async () => {
    try {
      await api('/api/auth/sessions/revoke', { method: 'POST' });
      toast('Signed out of every other device');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#a-save').addEventListener('click', async () => {
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: $('#a-current').value, newPassword: $('#a-new').value } });
      toast('Password updated');
      $('#a-current').value = '';
      $('#a-new').value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function renderApiKeys() {
  const host = $('#ak-list');
  if (!host) return;
  const { keys } = await api('/api/auth/api-keys').catch(() => ({ keys: [] }));
  host.innerHTML = keys.length
    ? `<div class="table-wrap"><table><tbody>${keys
        .map(
          (k) => `<tr><td><b>${esc(k.name)}</b> <span class="badge ${k.readOnly ? '' : 'warn'}">${k.readOnly ? 'Read-only' : 'Full access'}</span><div class="faint mono" style="font-size:12px">${esc(k.prefix)}…</div></td>
            <td class="faint nowrap">${k.lastUsed ? `Used ${esc(fmtTime(k.lastUsed))}` : 'Never used'}</td>
            <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-ak="${esc(k.id)}">Delete</button></td></tr>`
        )
        .join('')}</tbody></table></div>`
    : '<div class="faint">No keys yet.</div>';
  host.querySelectorAll('[data-ak]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/auth/api-keys/${btn.dataset.ak}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      renderApiKeys();
    })
  );
  const create = $('#ak-create');
  create.onclick = async () => {
    try {
      const made = await api('/api/auth/api-keys', { method: 'POST', body: { name: $('#ak-name').value, readOnly: $('#ak-ro').checked } });
      $('#ak-name').value = '';
      openModal({
        title: 'Your new API key',
        width: 520,
        body: `<p style="margin-top:0">Copy it now. It is not shown again.</p><pre class="share-box mono" style="white-space:pre-wrap;word-break:break-all">${esc(made.key)}</pre>`,
        actions: [{ label: 'Copy', primary: true, onClick: () => copyToClipboard(made.key) }, { label: 'Done', close: true }],
      });
      renderApiKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

function renderTwoFactor(me) {
  const body = $('#tf-body');
  if (!body) return;

  if (me.twoFactor) {
    body.innerHTML = `
      <p class="faint" style="margin:0 0 14px;line-height:1.6">
        <span class="status running" style="padding:0;background:none"><i class="dot"></i></span>
        On. Signing in asks for a code from your authenticator app.
        ${me.recoveryCodesLeft != null ? `You have <b>${me.recoveryCodesLeft}</b> recovery code${me.recoveryCodesLeft === 1 ? '' : 's'} left.` : ''}
      </p>
      <div class="row">
        <button class="btn" id="tf-codes">New recovery codes</button>
        <button class="btn btn-danger" id="tf-off">Turn off</button>
      </div>`;
    $('#tf-codes').addEventListener('click', () =>
      askPassword('New recovery codes', 'Your old recovery codes stop working.', false, async ({ password }) => {
        const data = await api('/api/auth/2fa/recovery-codes', { method: 'POST', body: { password } });
        showRecoveryCodes(data.recoveryCodes);
        me.recoveryCodesLeft = data.recoveryCodes.length;
        renderTwoFactor(me);
      })
    );
    $('#tf-off').addEventListener('click', () =>
      askPassword('Turn off two-factor sign-in', 'Signing in will only need your password again.', true, async ({ password, code }) => {
        await api('/api/auth/2fa/disable', { method: 'POST', body: { password, code } });
        toast('Two-factor sign-in is off');
        me.twoFactor = false;
        renderTwoFactor(me);
      })
    );
    return;
  }

  body.innerHTML = `
    <p class="faint" style="margin:0 0 14px;line-height:1.6">
      Off. Turn it on and signing in also asks for a 6-digit code from an app on your phone. Any authenticator works:
      Apple Passwords, Google or Microsoft Authenticator, 2FAS, Aegis, 1Password, Bitwarden…
    </p>
    <button class="btn btn-primary" id="tf-on">Turn on</button>`;
  $('#tf-on').addEventListener('click', () => startSetup(me));
}

async function startSetup(me) {
  let setup;
  try {
    setup = await api('/api/auth/2fa/setup', { method: 'POST', body: {} });
  } catch (err) {
    return toast(err.message, 'error');
  }
  const body = $('#tf-body');
  const grouped = setup.secret.match(/.{1,4}/g).join(' ');
  body.innerHTML = `
    <div class="tf-setup" style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:22px;align-items:start">
      <div class="qr-box">${qrSvg(setup.url, { size: 184 })}</div>
      <div>
        <div class="field-label">1 · Scan it</div>
        <p class="faint" style="margin:0 0 10px;line-height:1.6">
          Open your authenticator app and scan the code. On iPhone, the Camera app works too: it offers to add it to Passwords.
          <a href="${esc(setup.url)}">On this phone? Open it in the app</a>.
        </p>
        <div class="faint" style="font-size:12.5px">Or enter this key by hand (time-based):</div>
        <div class="row" style="margin:4px 0 16px">
          <span class="mono" style="letter-spacing:.06em">${esc(grouped)}</span>
          <button class="btn btn-sm" id="tf-copy">Copy</button>
        </div>
        <div class="field-label">2 · Type the code it shows</div>
        <div class="otp" id="tf-otp" style="max-width:360px">${otpMarkup()}</div>
        <p id="tf-error" class="faint hidden" style="color:var(--red);margin:0 0 8px"></p>
        <button class="btn btn-sm btn-ghost" id="tf-cancel">Cancel</button>
      </div>
    </div>`;

  $('#tf-copy').addEventListener('click', (e) => copyToClipboard(setup.secret, e.currentTarget));
  $('#tf-cancel').addEventListener('click', () => renderTwoFactor(me));

  const otp = wireOtp($('#tf-otp'), async (code) => {
    $('#tf-error').classList.add('hidden');
    try {
      const data = await api('/api/auth/2fa/enable', { method: 'POST', body: { code } });
      await otp.success();
      me.twoFactor = true;
      me.recoveryCodesLeft = data.recoveryCodes.length;
      renderTwoFactor(me);
      showRecoveryCodes(data.recoveryCodes, true);
      return true;
    } catch (err) {
      $('#tf-error').textContent = err.message;
      $('#tf-error').classList.remove('hidden');
      return false;
    }
  });
  otp.focus();
}

function showRecoveryCodes(codes, justEnabled = false) {
  const text = codes.join('\n');
  const modal = openModal({
    title: justEnabled ? 'Two-factor sign-in is on' : 'New recovery codes',
    width: 480,
    body: `
      <p style="margin:0 0 14px;line-height:1.6">Save these somewhere safe. Each one signs you in once if your phone is lost. This is the only time they are shown.</p>
      <div class="recovery-codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`,
    actions: [
      { label: 'Copy', onClick: (btn) => copyToClipboard(text, btn) },
      {
        label: 'Download',
        onClick: () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([`${state.user.username} recovery codes (${location.host})\n\n${text}\n`], { type: 'text/plain' }));
          a.download = 'gamepanel-recovery-codes.txt';
          a.click();
          URL.revokeObjectURL(a.href);
        },
      },
      { label: 'Done', primary: true, close: true },
    ],
  });
  return modal;
}

function askPassword(title, message, withCode, onConfirm) {
  const modal = openModal({
    title,
    width: 440,
    body: `
      <p style="margin:0 0 14px;line-height:1.6">${esc(message)}</p>
      <div class="form-grid" style="grid-template-columns:1fr">
        <label><span>Your password</span><input id="ap-password" type="password" autocomplete="current-password" /></label>
        ${withCode ? '<label><span>Code from your app (or a recovery code)</span><input id="ap-code" inputmode="numeric" autocomplete="one-time-code" /></label>' : ''}
      </div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Confirm',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          try {
            await onConfirm({ password: $('#ap-password').value, code: $('#ap-code')?.value.trim() });
            modal.close();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
}

/** Google, Discord and GitHub accounts this panel account can sign in with. */
async function renderLinkedAccounts(host) {
  const data = await api('/api/auth/oauth/providers').catch(() => null);
  if (!data?.providers.length || !host?.isConnected) return;
  const linked = state.user.identities || {};
  host.innerHTML = `
    <div class="card mb-16">
      <h4>Sign in with another account</h4>
      <div class="faint" style="margin-bottom:12px">Link one and you can use its button on the sign-in page instead of your password. Two-factor sign-in still applies.</div>
      <div class="list">${data.providers
        .map(
          (p) => `<div class="list-row">
            <div class="grow"><div class="title">${esc(p.label)}</div><div class="sub">${linked[p.id] ? `Linked to ${esc(linked[p.id])}` : 'Not linked'}</div></div>
            ${
              linked[p.id]
                ? `<button class="btn btn-sm btn-ghost btn-danger" data-unlink="${esc(p.id)}">Unlink</button>`
                : `<a class="btn btn-sm" href="/api/auth/oauth/${encodeURIComponent(p.id)}/start?link=1">Link ${esc(p.label)}</a>`
            }
          </div>`
        )
        .join('')}</div>
    </div>`;
  host.querySelectorAll('[data-unlink]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        const { user } = await api(`/api/auth/oauth/${btn.dataset.unlink}`, { method: 'DELETE' });
        state.user = { ...state.user, ...user };
        toast('Unlinked');
        renderLinkedAccounts(host);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}
