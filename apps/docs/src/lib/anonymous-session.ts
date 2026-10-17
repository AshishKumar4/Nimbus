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
 * once made (nimbus:client-id): that session moves to `key`, unless one is
 * there, and the old keys are removed, so later boots find none.
 */
export function adoptLegacyCachedSession(key: string): void {
  try {
    const id = localStorage.getItem('nimbus:client-id');
    if (id === null) return;
    const legacyKey = SESSION_KEY_PREFIX + id;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null && localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
    localStorage.removeItem('nimbus:client-id');
  } catch {}
}

export function readCachedSession(key: string): AnonymousSession | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as AnonymousSession;
    if (typeof cached.wsUrl !== 'string') return null;
    if (typeof cached.expiresAt !== 'number' || !Number.isFinite(cached.expiresAt)) return null;
    if (Date.now() + ATTACH_MARGIN_MS >= cached.expiresAt) return null;
    return cached;
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
