/**
 * git/pack/upload-pack.ts — the client side of git's smart HTTP fetch
 * (Documentation/gitprotocol-http.txt, gitprotocol-pack.txt), protocol v0.
 *
 * discover() reads the advertisement; requestPack() sends one request (wants,
 * shallows, deepen, filter, haves, done: no multi-round negotiation) and
 * returns the shallow lines and the pack as a stream that is read only as
 * fast as its consumer pulls, so nothing between the network and the pack
 * processor buffers more than one side-band packet.
 */
import { retrying } from '@nimbus-sh/platform/retry.js';
import { RETRY_ATTEMPTS, RETRY_BACKOFF_MS, STALL_MS, TRANSIENT_HTTP_STATUSES, UploadPackError, agentCapability, gitHttpHeaders, gitHttpRemote } from './transport.js';
import { PktReader, pktLine, text } from './pkt-line.js';
import { PackFormatError } from './format.js';
import { answeredFailure, transportFailure } from './remote-failure.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/**
 * The repository's URL without credentials, and the credentials to send: a
 * URL's own (https://user:password@host/repo.git), as git takes them, else
 * the options'.
 */
/** A request whose transient failures are retried before any byte is read (transport.ts). */
async function send(options, path, init) {
    const doFetch = options.fetch ?? fetch;
    const { url, auth } = gitHttpRemote(options);
    const request = { ...init, headers: gitHttpHeaders(auth, init.headers) };
    const failed = init.method === 'POST' ? 'rpc' : 'discovery';
    // Headers that do not come within the stall time are a stall too.
    const stallMs = options.stallMs ?? STALL_MS;
    const attempt = async () => {
        let timer = null;
        const stalled = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const detail = 'no response for ' + Math.round(stallMs / 1000) + ' s';
                reject(new UploadPackError(detail, undefined, transportFailure(failed, detail)));
            }, stallMs);
        });
        try {
            return await Promise.race([doFetch(url + path, { ...request, signal: options.signal }), stalled]);
        }
        finally {
            if (timer !== null)
                clearTimeout(timer);
        }
    };
    try {
        return await retrying(attempt, {
            retries: RETRY_ATTEMPTS - 1,
            schedule: RETRY_BACKOFF_MS,
            retryReason: (outcome) => !outcome.ok ? 'failed in transit'
                : TRANSIENT_HTTP_STATUSES.has(outcome.value.status) ? 'HTTP ' + outcome.value.status
                    : null,
            discard: (response) => response.body?.cancel(),
        });
    }
    catch (error) {
        if (error instanceof UploadPackError)
            throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new UploadPackError('the request failed: ' + detail, undefined, transportFailure(failed, detail));
    }
}
export { STALL_MS };
export async function discover(options, service = 'git-upload-pack') {
    const response = await send(options, '/info/refs?service=' + service, {
        headers: { accept: 'application/x-' + service + '-advertisement' },
    });
    if (!response.ok || !response.body) {
        // The server's text, as git shows it, with the status.
        const failure = await answeredFailure('discovery', response.status, response.headers.get('content-type'), response.body);
        if (response.status === 401 || response.status === 403) {
            throw new UploadPackError('authentication failed (HTTP ' + response.status + ')', response.status, failure);
        }
        throw new UploadPackError('discovery answered HTTP ' + response.status, response.status, failure);
    }
    const reader = new PktReader(response.body.getReader(), options.stallMs);
    const first = await reader.next();
    if (!first || text(first) !== '# service=' + service)
        throw new UploadPackError('not a smart HTTP server');
    if (await reader.next() !== null)
        throw new UploadPackError('advertisement header lacks its flush');
    const advertisement = { refs: new Map(), symrefs: new Map(), capabilities: new Set() };
    let firstRef = true;
    for (;;) {
        const payload = await reader.next();
        if (payload === null || payload === undefined)
            break;
        let line = text(payload);
        if (firstRef) {
            const nul = line.indexOf('\0');
            if (nul >= 0) {
                for (const capability of line.slice(nul + 1).split(' ')) {
                    if (!capability)
                        continue;
                    advertisement.capabilities.add(capability);
                    if (capability.startsWith('symref=')) {
                        const [from, to] = capability.slice('symref='.length).split(':');
                        if (from && to)
                            advertisement.symrefs.set(from, to);
                    }
                }
                line = line.slice(0, nul);
            }
            firstRef = false;
        }
        const space = line.indexOf(' ');
        const oid = line.slice(0, space);
        const name = line.slice(space + 1);
        if (name === 'capabilities^{}')
            continue;
        advertisement.refs.set(name, oid);
    }
    await reader.cancel().catch(() => undefined);
    return advertisement;
}
/** Capabilities to ask for, from those the server offers. */
function requestCapabilities(advertised, request) {
    // include-tag: annotated tags of the objects sent come with them, as git asks (clone follows them).
    const capabilities = ['side-band-64k', 'ofs-delta', ...(request.includeTag === false ? [] : ['include-tag'])].filter((capability) => advertised.has(capability));
    if (!advertised.has('side-band-64k'))
        throw new UploadPackError('the server does not offer side-band-64k');
    if (request.thin && advertised.has('thin-pack'))
        capabilities.push('thin-pack');
    const deepens = request.depth !== undefined || request.deepenSince !== undefined || (request.deepenNot?.length ?? 0) > 0;
    if (deepens || (request.shallows?.length ?? 0) > 0) {
        if (!advertised.has('shallow'))
            throw new UploadPackError('the server does not support shallow fetches');
        capabilities.push('shallow');
    }
    if (request.relative) {
        if (!advertised.has('deepen-relative'))
            throw new UploadPackError('the server does not support --deepen');
        capabilities.push('deepen-relative');
    }
    // fetch-pack.c: the server must offer each deepen option the request uses.
    for (const [used, capability] of [
        [request.deepenSince !== undefined, 'deepen-since'],
        [(request.deepenNot?.length ?? 0) > 0, 'deepen-not'],
    ]) {
        if (!used)
            continue;
        if (!advertised.has(capability))
            throw new UploadPackError('the server does not support ' + capability);
        capabilities.push(capability);
    }
    if (request.filter !== undefined) {
        if (!advertised.has('filter'))
            throw new UploadPackError('the server does not support --filter');
        capabilities.push('filter');
    }
    capabilities.push(...agentCapability(advertised));
    return capabilities;
}
/** One request, and the pack it answers with. */
export async function requestPack(options, advertised, request) {
    if (request.wants.length === 0)
        throw new UploadPackError('a fetch wants at least one object');
    const capabilities = requestCapabilities(advertised, request);
    const lines = [];
    request.wants.forEach((oid, index) => lines.push(pktLine('want ' + oid + (index === 0 ? ' ' + capabilities.join(' ') : '') + '\n')));
    for (const oid of request.shallows ?? [])
        lines.push(pktLine('shallow ' + oid + '\n'));
    if (request.depth !== undefined)
        lines.push(pktLine('deepen ' + request.depth + '\n'));
    if (request.deepenSince !== undefined)
        lines.push(pktLine('deepen-since ' + request.deepenSince + '\n'));
    for (const ref of request.deepenNot ?? [])
        lines.push(pktLine('deepen-not ' + ref + '\n'));
    if (request.filter !== undefined)
        lines.push(pktLine('filter ' + request.filter + '\n'));
    lines.push(encoder.encode('0000'));
    for (const oid of request.haves ?? [])
        lines.push(pktLine('have ' + oid + '\n'));
    lines.push(pktLine('done\n'));
    let total = 0;
    for (const line of lines)
        total += line.byteLength;
    const body = new Uint8Array(total);
    let at = 0;
    for (const line of lines) {
        body.set(line, at);
        at += line.byteLength;
    }
    const response = await send(options, '/git-upload-pack', {
        method: 'POST',
        body,
        headers: {
            'content-type': 'application/x-git-upload-pack-request',
            accept: 'application/x-git-upload-pack-result',
        },
    });
    if (!response.ok || !response.body) {
        const failure = await answeredFailure('rpc', response.status, response.headers.get('content-type'), response.body);
        throw new UploadPackError('the request answered HTTP ' + response.status, response.status, failure);
    }
    const reader = new PktReader(response.body.getReader(), options.stallMs);
    const result = { shallows: [], unshallows: [], pack: null };
    // shallow-info (after deepen or shallow lines), then ACK/NAK.
    for (;;) {
        const payload = await reader.next();
        if (payload === undefined)
            throw new UploadPackError('the response ended before its acknowledgement');
        if (payload === null)
            continue;
        const line = text(payload);
        if (line.startsWith('shallow '))
            result.shallows.push(line.slice(8));
        else if (line.startsWith('unshallow '))
            result.unshallows.push(line.slice(10));
        else if (line === 'NAK' || line.startsWith('ACK '))
            break;
        else if (line.startsWith('ERR '))
            throw new UploadPackError(line.slice(4));
        else
            throw new UploadPackError('unexpected line ' + JSON.stringify(line.slice(0, 80)));
    }
    result.pack = sideBandPack(reader, options.onProgress);
    return result;
}
/** Band 1 of side-band-64k, pulled packet by packet; band 2 is progress, band 3 a fatal error. */
async function* sideBandPack(reader, onProgress) {
    let finished = false;
    let partial = '';
    const progress = (text) => {
        if (!onProgress)
            return;
        // A redraw ends in \r, a finished line in \n.
        const lines = (partial + text).split(/\r|\n/);
        partial = lines.pop() ?? '';
        for (const line of lines)
            if (/, done\.$|^Total /.test(line))
                onProgress(line);
    };
    try {
        for (;;) {
            const payload = await reader.next();
            if (payload === undefined || payload === null) {
                finished = true;
                return;
            }
            const band = payload[0];
            if (band === 1)
                yield payload.subarray(1);
            else if (band === 2)
                progress(decoder.decode(payload.subarray(1)));
            else if (band === 3)
                throw new UploadPackError('remote error: ' + decoder.decode(payload.subarray(1)).trim());
            else
                throw new PackFormatError('side-band packet on unknown band ' + band);
        }
    }
    finally {
        if (!finished)
            await reader.cancel().catch(() => undefined);
    }
}
