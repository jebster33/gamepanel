import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { openModal } from '../ui/modal.js';
import { otpMarkup, wireOtp } from '../ui/otp.js';
import { qrSvg } from '../ui/qr.js';

/* --------------------------------------------------------------- account */

/** Your own sign-in: password and two-factor. Open to every account. */
export async function renderAccount(view) {
  setCrumbs('Account');
  const me = await api('/api/auth/me').then((d) => d.user).catch(() => state.user);
  state.user = { ...state.user, ...me };

  view.innerHTML = `
    <div class="page-head"><div><h1>Account</h1><div class="lede">Signed in as <b>${esc(me.username)}</b>${
      me.lastLogin ? ` · last sign-in ${esc(fmtTime(me.lastLogin))}` : ''
    }</div></div></div>

    <div class="card mb-16" id="twofactor">
      <h4>Two-factor sign-in</h4>
      <div id="tf-body"></div>
    </div>

    <div class="card mb-16">
      <h4>Change your password</h4>
      <div class="form-grid">
        <label><span>Current password</span><input id="a-current" type="password" autocomplete="current-password" /></label>
        <label><span>New password</span><input id="a-new" type="password" autocomplete="new-password" /></label>
      </div>
      <button class="btn mt-16" id="a-save">Update password</button>
    </div>`;

  renderTwoFactor(me);

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
