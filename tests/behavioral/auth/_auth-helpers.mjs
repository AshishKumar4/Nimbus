// auth/_auth-helpers.mjs — shared helpers for the AGT-1.1 auth probes.
//
// All probes assume:
//   - BASE points at a Worker deployment (or wrangler dev).
//   - NIMBUS_ADMIN_KEY env var holds the wrangler-secret ADMIN_KEY
//     used to mint the first key via /auth/keys/create. If unset,
//     the probe assumes the deployment has no auth gate (legacy)
//     and tags itself RED accordingly.

export const BASE = process.env.BASE || 'http://127.0.0.1:8792';
export const ADMIN_KEY = process.env.NIMBUS_ADMIN_KEY || '';

/** Mint a fresh API key via the admin endpoint. Returns the plaintext key. */
export async function mintKey(name = 'probe-' + Date.now()) {
  if (!ADMIN_KEY) {
    throw new Error('mintKey: NIMBUS_ADMIN_KEY env var required');
  }
  const r = await fetch(`${BASE}/auth/keys/create`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`mintKey failed: HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.key || !data.keyId) {
    throw new Error(`mintKey: response missing key/keyId: ${JSON.stringify(data)}`);
  }
  return { keyId: data.keyId, key: data.key };
}

/** Revoke a key. */
export async function revokeKey(keyId) {
  const r = await fetch(`${BASE}/auth/keys/revoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ keyId }),
  });
  return r.ok;
}

/** Mint a session ID. Auth-gated when the wave ships; uses ADMIN_KEY. */
export async function mintSessionWithAuth() {
  const r = await fetch(`${BASE}/new`, {
    method: 'POST',
    redirect: 'manual',
    headers: ADMIN_KEY ? { 'Authorization': `Bearer ${ADMIN_KEY}` } : {},
  });
  const loc = r.headers.get('location');
  if (!loc) {
    throw new Error(`POST /new returned no Location (status ${r.status})`);
  }
  const m = loc.match(/\/s\/([^/]+)/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}
