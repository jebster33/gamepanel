import { api } from './api.js';

/* Passkeys in the browser: turn the server's options into what navigator.credentials wants, and back. */

const toBuf = (b64u) => Uint8Array.from(atob(String(b64u).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(b64u).length / 4) * 4, '=')), (c) => c.charCodeAt(0)).buffer;
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Passkeys work on HTTPS (or localhost) at a name, not an IP address. */
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

const friendly = (err) =>
  err?.name === 'NotAllowedError' ? new Error('Cancelled, or no passkey for this panel on this device') : err?.name === 'InvalidStateError' ? new Error('This device already has a passkey for your account') : err;

/** Sign in: returns the same answer as a password sign-in (a session, or a ticket for the code step). */
export async function signInWithPasskey() {
  const { requestId, options } = await api('/api/auth/passkey/options', { method: 'POST', body: {} });
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: [] } });
  } catch (err) {
    throw friendly(err);
  }
  return api('/api/auth/passkey/login', { method: 'POST', body: { requestId, credential: serialize(cred) } });
}

/** Add a passkey to the signed-in account. Returns the updated account. */
export async function addPasskey(name) {
  const { requestId, options } = await api('/api/auth/passkeys/options', { method: 'POST', body: {} });
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
    throw friendly(err);
  }
  const { user } = await api('/api/auth/passkeys', { method: 'POST', body: { requestId, credential: serialize(cred), name } });
  return user;
}
