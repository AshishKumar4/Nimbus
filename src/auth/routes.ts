/**
 * auth/routes.ts — handler dispatch for /__auth__/* (internal,
 * Worker→DO) and /auth/keys/* (public admin).
 *
 * Two entry points the auth DO accepts:
 *
 *   /__auth__/validate   — POST {token} → ValidateResult JSON
 *                          (Worker middleware calls this on every
 *                          gated request; ALSO an internal hot path,
 *                          NEVER exposed publicly. The Worker entry
 *                          rejects external requests to /__auth__/*.)
 *
 *   /auth/keys/create    — POST {name, ownerEmail?} → {keyId, key}
 *   /auth/keys/list      — GET → {keys: ApiKeyView[]}
 *   /auth/keys/revoke    — POST {keyId} → {ok: boolean}
 *
 * Admin paths (/auth/keys/*) are also routed through the auth DO via
 * the same /__auth__/* internal forwarder — the Worker entry rewrites
 * /auth/keys/X → /__auth__/keys/X before forwarding to the DO. This
 * keeps the DO's storage-touching code in one place.
 */

import { KeyRegistry } from './api-keys.js';

/** Lazily-constructed singleton-per-DO. */
let registryInstance: KeyRegistry | null = null;

/**
 * Handle an auth-related request inside the auth DO. Returns null if
 * the path is not an auth path (caller should fall through to normal
 * session-DO routing — but in practice the auth DO never receives
 * non-auth paths because the reserved-ID guard rejects them).
 */
export async function handleAuthRequest(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/__auth__/')) return null;

  if (!registryInstance) {
    registryInstance = new KeyRegistry(storage);
  }
  const reg = registryInstance;

  // /__auth__/validate — token validation hot path.
  if (path === '/__auth__/validate' && request.method === 'POST') {
    let body: any;
    try { body = await request.json(); } catch { return jsonResp({ kind: 'invalid' }, 200); }
    const token = typeof body?.token === 'string' ? body.token : '';
    const result = await reg.validate(token);
    // Strip ApiKeyRecord from the response; the Worker entry doesn't need it.
    if (result.kind === 'ok') {
      return jsonResp({ kind: 'ok', keyId: result.keyId }, 200);
    }
    return jsonResp(result, 200);
  }

  // /__auth__/keys/create — POST {name, ownerEmail?}.
  if (path === '/__auth__/keys/create' && request.method === 'POST') {
    let body: any;
    try { body = await request.json(); } catch { return jsonResp({ error: 'invalid json' }, 400); }
    const name = String(body?.name || '').trim();
    if (!name) return jsonResp({ error: 'name required' }, 400);
    const ownerEmail = body?.ownerEmail ? String(body.ownerEmail).trim() : undefined;
    const result = await reg.create(name, ownerEmail);
    return jsonResp(result, 200);
  }

  // /__auth__/keys/list — GET.
  if (path === '/__auth__/keys/list' && request.method === 'GET') {
    const keys = await reg.list();
    return jsonResp({ keys }, 200);
  }

  // /__auth__/keys/revoke — POST {keyId}.
  if (path === '/__auth__/keys/revoke' && request.method === 'POST') {
    let body: any;
    try { body = await request.json(); } catch { return jsonResp({ error: 'invalid json' }, 400); }
    const keyId = String(body?.keyId || '').trim();
    if (!keyId) return jsonResp({ error: 'keyId required' }, 400);
    const ok = await reg.revoke(keyId);
    if (!ok) return jsonResp({ error: 'no such key' }, 404);
    return jsonResp({ ok: true }, 200);
  }

  return jsonResp({ error: 'not found' }, 404);
}

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
