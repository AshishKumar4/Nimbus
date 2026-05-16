/**
 * cli/commands/session — `nimbus session new` — mint a session via POST /new.
 */

/** Mint a fresh session and print its attach URL. */
export async function newSession(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  const endpoint = parsed['--endpoint']
    ?? process.env.NIMBUS_ENDPOINT
    ?? 'http://127.0.0.1:8787';

  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, '')}/new`, {
      method: 'POST',
      redirect: 'manual',
    });
    const loc = r.headers.get('Location');
    if (!loc) {
      process.stderr.write(`nimbus session new: POST /new returned no Location (status ${r.status})\n`);
      return 70;
    }
    const m = loc.match(/\/s\/([^/]+)/);
    if (!m) {
      process.stderr.write(`nimbus session new: unexpected Location: ${loc}\n`);
      return 70;
    }
    const sessionId = m[1];
    const url = `${endpoint.replace(/\/+$/, '')}/s/${sessionId}/`;
    process.stdout.write(JSON.stringify({ sessionId, url }) + '\n');
    return 0;
  } catch (e: any) {
    process.stderr.write(`nimbus session new: ${e?.message || e}\n`);
    return 70;
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    out[a] = args[i + 1] ?? '';
    i++;
  }
  return out;
}
