// Production probe bootstrap: nimbus-os.dev gates POST /new on an interactive
// Cloudflare login, so a headless run mints a session through the public
// anonymous demo endpoint instead and drives the normal driver helpers with the
// sid-pinned attach token it returns.
//
// Import this BEFORE ../_driver.mjs — the driver reads its credential from the
// environment at import time.
//
//   const { sid } = await bootstrapProductionSession();
//   const { Terminal } = await import('./_driver.mjs');

export async function bootstrapProductionSession(base = process.env.BASE || 'https://nimbus-os.dev') {
  const created = await fetch(`${base}/api/demo/anon-session`, { method: 'POST' });
  const body = await created.json().catch(() => ({}));
  if (!created.ok) {
    throw new Error(
      `anon session ${created.status}: ${JSON.stringify(body)}`
      + (created.status === 429 ? ' (per-IP rate limit; retry in a minute)' : '')
      + (created.status === 503 ? ' (global anon capacity reached)' : ''),
    );
  }
  const token = new URL(body.wsUrl, base).searchParams.get('nimbus_token');
  if (!body.sessionId || !token) throw new Error(`anon session gave no sid/token: ${JSON.stringify(body)}`);
  process.env.BASE = base;
  process.env.NIMBUS_PROBE_TOKEN = token;
  return { sid: body.sessionId, token, expiresAt: body.expiresAt };
}
