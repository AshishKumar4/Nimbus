/**
 * cli/commands/session — `nimbus session new` — mint a session via POST /new.
 */
/** Mint a fresh session and print its attach URL. */
export async function newSession(args) {
    const parsed = parseFlags(args);
    const endpoint = parsed['--endpoint']
        ?? process.env.NIMBUS_ENDPOINT
        ?? 'http://127.0.0.1:8787';
    try {
        const baseUrl = new URL(endpoint);
        const r = await fetch(new URL('/new', baseUrl), {
            method: 'POST',
            redirect: 'manual',
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
        const url = new URL(`/s/${encodeURIComponent(sessionId)}/`, baseUrl).toString();
        process.stdout.write(JSON.stringify({ sessionId, url }) + '\n');
        return 0;
    }
    catch (e) {
        process.stderr.write(`nimbus session new: ${e?.message || e}\n`);
        return 70;
    }
}
function parseFlags(args) {
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('--'))
            continue;
        out[a] = args[i + 1] ?? '';
        i++;
    }
    return out;
}
function sessionIdFromLocation(location, baseUrl) {
    let url;
    try {
        url = new URL(location, baseUrl);
    }
    catch {
        return null;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0] !== 's')
        return null;
    try {
        return decodeURIComponent(segments[1]);
    }
    catch {
        return null;
    }
}
