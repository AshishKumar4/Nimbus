export interface AnonymousSession {
  wsUrl: string;
  expiresAt: number | null;
}

const ATTACH_MARGIN_MS = 5_000;

export class SandboxUnavailableError extends Error {
  constructor(public status: number) {
    super(`attach endpoint returned ${status}`);
  }
}

const SESSION_KEY_PREFIX = 'nimbus:anon-session:';

/**
 * The key a browser keeps the session it booted from `attachUrl` under: one
 * per attach endpoint, localStorage being per browser and origin already.
 */
export function sessionCacheKey(attachUrl: string): string {
  return SESSION_KEY_PREFIX + attachUrl;
}

/**
 * Once per browser that cached its session under the per-browser id the docs
 * once made (nimbus:client-id): the old keys are removed first, so the move
 * needs no room for two copies, and that session moves to `key` unless one is
 * there. Answers it when it could not be stored, for this boot to use.
 */
export function adoptLegacyCachedSession(key: string): AnonymousSession | null {
  let legacy: string | null = null;
  try {
    const id = localStorage.getItem('nimbus:client-id');
    if (id === null) return null;
    legacy = localStorage.getItem(SESSION_KEY_PREFIX + id);
    localStorage.removeItem(SESSION_KEY_PREFIX + id);
    localStorage.removeItem('nimbus:client-id');
    if (legacy !== null && localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
    return null;
  } catch {
    return legacy === null ? null : parseCachedSession(legacy);
  }
}

export function readCachedSession(key: string): AnonymousSession | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parseCachedSession(raw) : null;
  } catch {
    return null;
  }
}

/** A cached session's record, if it is one still worth attaching to. */
function parseCachedSession(raw: string): AnonymousSession | null {
  try {
    const cached: { wsUrl?: string | number | null; expiresAt?: string | number | null } | null = JSON.parse(raw);
    if (cached === null || typeof cached !== 'object') return null;
    const { wsUrl, expiresAt } = cached;
    if (typeof wsUrl !== 'string') return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
    if (Date.now() + ATTACH_MARGIN_MS >= expiresAt) return null;
    return { wsUrl, expiresAt };
  } catch {
    return null;
  }
}

export function cacheSession(key: string, session: AnonymousSession): void {
  if (session.expiresAt === null) {
    clearCachedSession(key);
    return;
  }
  try { localStorage.setItem(key, JSON.stringify(session)); } catch {}
}

export function clearCachedSession(key: string): void {
  try { localStorage.removeItem(key); } catch {}
}

export async function createSession(attachUrl: string): Promise<AnonymousSession> {
  if (/^wss?:/i.test(attachUrl)) return { wsUrl: attachUrl, expiresAt: null };
  const response = await fetch(attachUrl, { method: 'POST' });
  if (!response.ok) throw new SandboxUnavailableError(response.status);
  const body = await response.json() as { wsUrl?: string; expiresAt?: number };
  if (typeof body.wsUrl !== 'string' || !body.wsUrl) throw new Error('attach endpoint returned no wsUrl');
  if (body.expiresAt !== undefined && (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt))) throw new Error('attach endpoint returned invalid expiresAt');
  const resolved = new URL(body.wsUrl, attachUrl);
  if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
  if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
  return { wsUrl: resolved.href, expiresAt: body.expiresAt ?? null };
}
