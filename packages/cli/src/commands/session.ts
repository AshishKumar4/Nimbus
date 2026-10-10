/**
 * cli/commands/session — `nimbus session new` — mint a session via POST /new.
 *
 * `--token` / `NIMBUS_TOKEN` travels ONLY as `Authorization: Bearer`.
 * The printed attach URL is the server's redirect Location verbatim: on
 * enforced deployments it carries a short-lived single-use bootstrap
 * token (never the caller's long-lived token); on unauthenticated
 * deployments it is the plain `/s/<id>/` URL.
 */

import { parseArgs } from 'node:util';

/** Mint a fresh session and print its attach URL. */
export async function newSession(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { endpoint: { type: 'string' }, token: { type: 'string' } } }).values;
  } catch (error) {
    process.stderr.write(`nimbus session new: ${error instanceof Error ? error.message : error}\n`);
    return 64;
  }
  const endpoint = parsed.endpoint
    ?? process.env.NIMBUS_ENDPOINT
    ?? 'http://127.0.0.1:8787';
  const token = parsed.token ?? process.env.NIMBUS_TOKEN ?? '';

  try {
    const baseUrl = new URL(endpoint);
    const r = await fetch(new URL('/new', baseUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    const loc = r.headers.get('Location');
    if (!loc) {
      process.stderr.write(`nimbus session new: POST /new returned no Location (status ${r.status})\n`);
      return 70;
    }
    const sessionId = sessionIdFromLocation(loc, baseUrl);
    if (!sessionId) {
      process.stderr.write(`nimbus session new: unexpected Location: ${loc}\n`);
      return 70;
    }
    const url = new URL(loc, baseUrl).toString();
    process.stdout.write(JSON.stringify({ sessionId, url }) + '\n');
    return 0;
  } catch (e: any) {
    process.stderr.write(`nimbus session new: ${e?.message || e}\n`);
    return 70;
  }
}

function sessionIdFromLocation(location: string, baseUrl: URL): string | null {
  let url: URL;
  try {
    url = new URL(location, baseUrl);
  } catch {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 's') return null;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
}
