export const DEMO_OAUTH_CALLBACK_PATH = '/api/nimbus/oauth/callback';

export function readDemoAuthConfig(env: any, origin: string) {
  const redirectUri = envString(env, 'DEMO_CF_OAUTH_REDIRECT_URI')
    || envString(env, 'NIMBUS_CF_OAUTH_REDIRECT_URI')
    || (origin ? `${origin}${DEMO_OAUTH_CALLBACK_PATH}` : '');
  const scopes = mergeScopes(
    'user-details.read',
    envString(env, 'NIMBUS_CF_OAUTH_SCOPES'),
    envString(env, 'DEMO_CF_OAUTH_SCOPES'),
  );
  return {
    clientId: envString(env, 'DEMO_CF_OAUTH_CLIENT_ID') || envString(env, 'NIMBUS_CF_OAUTH_CLIENT_ID'),
    clientSecret: envString(env, 'DEMO_CF_OAUTH_CLIENT_SECRET') || envString(env, 'NIMBUS_CF_OAUTH_CLIENT_SECRET'),
    redirectUri,
    scopes,
    cookieSecret: envString(env, 'DEMO_AUTH_COOKIE_SECRET')
      || envString(env, 'NIMBUS_AGENT_COOKIE_SECRET')
      || envString(env, 'JWT_SECRET'),
    authCookieTtlMs: Math.max(1, envNumber(env, 'DEMO_AUTH_COOKIE_DAYS', 30)) * 24 * 60 * 60 * 1000,
  };
}

export function sanitizeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'https://nimbus.local');
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function envNumber(env: Record<string, unknown>, key: string, fallback: number): number {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function mergeScopes(...values: string[]): string[] {
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const value of values) {
    for (const scope of value.split(/\s+/g)) {
      const normalized = scope.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      scopes.push(normalized);
    }
  }
  return scopes;
}
