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

export function readCachedSession(key: string): AnonymousSession | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as AnonymousSession;
    if (typeof cached.wsUrl !== 'string') return null;
    if (cached.expiresAt !== null && !Number.isFinite(cached.expiresAt)) return null;
    if (cached.expiresAt !== null && Date.now() + ATTACH_MARGIN_MS >= cached.expiresAt) return null;
    return cached;
  } catch {
    return null;
  }
}

export function cacheSession(key: string, session: AnonymousSession): void {
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
  if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) throw new Error('attach endpoint returned no expiresAt');
  const resolved = new URL(body.wsUrl, attachUrl);
  if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
  if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
  return { wsUrl: resolved.href, expiresAt: body.expiresAt };
}
