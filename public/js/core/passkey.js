import { api } from './api.js';

/* Passkeys in the browser: turn the server's options into what navigator.credentials wants, and back. */

const toBuf = (b64u) => Uint8Array.from(atob(String(b64u).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(b64u).length / 4) * 4, '=')), (c) => c.charCodeAt(0)).buffer;
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Passkeys work on HTTPS (or localhost) at a name, not an IP address. */
/** Why passkeys cannot be used here, in words a person can act on. null when they can. */
export function passkeyBlocker() {
  const host = location.hostname;
  if (!window.PublicKeyCredential) return 'This browser does not support passkeys. Use a current Chrome, Edge, Safari or Firefox.';
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return 'Passkeys need the panel opened at a name (its domain, or localhost), not an IP address.';
  if (!window.isSecureContext) return 'Passkeys need HTTPS. Turn on HTTPS for the panel first (Settings, then HTTPS).';
  return null;
}

/** True when this device has Windows Hello, Touch ID / Face ID or Android biometrics ready. */
export async function platformPasskeyReady() {
  try {
    return !passkeyBlocker() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export function passkeysSupported() {
  const host = location.hostname;
  return Boolean(window.PublicKeyCredential && window.isSecureContext && !/^\d+(\.\d+){3}$/.test(host) && !host.includes(':') && !host.startsWith('['));
}

function serialize(cred) {
  const r = cred.response;
  const out = { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON) } };
  if (r.attestationObject) out.response.attestationObject = toB64u(r.attestationObject);
  if (r.authenticatorData) out.response.authenticatorData = toB64u(r.authenticatorData);
  if (r.signature) out.response.signature = toB64u(r.signature);
  if (r.userHandle) out.response.userHandle = toB64u(r.userHandle);
  return out;
}

const friendly = (err, kind = 'any') => {
  const blocker = passkeyBlocker();
  if (blocker) return new Error(blocker);
  const name = err?.name;
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for your account');
  if (name === 'NotSupportedError') {
    return new Error(
      kind === 'platform'
        ? 'This device cannot make a passkey. On Windows, set up Windows Hello (Settings, Accounts, Sign-in options). On a Mac or phone, turn on a screen lock, Touch ID or Face ID.'
        : 'This browser or key cannot make that kind of passkey'
    );
  }
  if (name === 'SecurityError') return new Error('The browser refused: the panel must be opened at its HTTPS address (a domain, not an IP address)');
  if (name === 'NotAllowedError') {
    return new Error(
      kind === 'platform'
        ? 'Cancelled or timed out. If no prompt appeared, Windows Hello or a screen lock may not be set up on this device.'
        : 'Cancelled, or no passkey for this panel on this device'
    );
  }
  if (name === 'AbortError') return new Error('Cancelled');
  return err;
};

let conditional = null;
const stopConditional = () => {
  conditional?.abort();
  conditional = null;
};

/** Sign in: returns the same answer as a password sign-in (a session, or a ticket for the code step). */
export async function signInWithPasskey() {
  stopConditional();
  const { requestId, options } = await api('/api/auth/passkey/options', { method: 'POST', body: {} });
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: [] } });
  } catch (err) {
    throw friendly(err);
  }
  return api('/api/auth/passkey/login', { method: 'POST', body: { requestId, credential: serialize(cred) } });
}

/**
 * Autofill sign-in: the browser offers the account's passkeys in the username
 * box's suggestions. Resolves with the sign-in answer, or null when there is
 * nothing to do (unsupported, cancelled, or replaced by a button click).
 */
export async function conditionalPasskeySignIn() {
  stopConditional();
  try {
    if (passkeyBlocker() || !PublicKeyCredential.isConditionalMediationAvailable || !(await PublicKeyCredential.isConditionalMediationAvailable())) return null;
    const ctl = new AbortController();
    conditional = ctl;
    const { requestId, options } = await api('/api/auth/passkey/options', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({ mediation: 'conditional', signal: ctl.signal, publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: [] } });
    if (!cred) return null;
    conditional = null;
    return await api('/api/auth/passkey/login', { method: 'POST', body: { requestId, credential: serialize(cred) } });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') return null;
    throw friendly(err);
  }
}

/**
 * Add a passkey to the signed-in account. kind: 'platform' (this device:
 * Windows Hello, Touch ID / Face ID, Android), 'security-key' (USB/NFC key) or
 * 'any'. Returns the updated account.
 */
export async function addPasskey(name, password, kind = 'any') {
  const { requestId, options } = await api('/api/auth/passkeys/options', { method: 'POST', body: { password, kind } });
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: toBuf(options.challenge),
        user: { ...options.user, id: toBuf(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: toBuf(c.id) })),
      },
    });
  } catch (err) {
    throw friendly(err, kind);
  }
  const credential = serialize(cred);
  try {
    credential.response.transports = cred.response.getTransports?.() || [];
  } catch {
    /* optional */
  }
  const { user } = await api('/api/auth/passkeys', { method: 'POST', body: { requestId, credential, name } });
  return user;
}
