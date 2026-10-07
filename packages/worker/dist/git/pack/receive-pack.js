/**
 * git/pack/receive-pack.ts — the client side of git's smart HTTP push
 * (Documentation/gitprotocol-http.txt, gitprotocol-pack.txt "Pushing Data
 * To a Server"), protocol v0, as send-pack speaks it.
 *
 * One request: the ref updates (old new ref), the push options, then the
 * pack of what the remote lacks, streamed as the caller makes it (never
 * held whole); the answer is receive-pack's report (report-status), carried
 * on side-band-64k band 1, its progress on band 2.
 */
import { PackFormatError } from './format.js';
import { discover, headers, PktReader, pktLine, repoUrl, text, UploadPackError } from './upload-pack.js';
const ZERO = /^0+$/;
const encoder = new TextEncoder();
/** The receive-pack side's refs and capabilities. */
export async function discoverReceivePack(options) {
    return await discover(options, 'git-receive-pack');
}
/** The capabilities a push asks for, from those receive-pack offers (send-pack.c). */
function pushCapabilities(advertised, request) {
    const capabilities = ['report-status'];
    if (!advertised.has('report-status'))
        throw new UploadPackError('the remote does not report the status of a push');
    if (advertised.has('side-band-64k'))
        capabilities.push('side-band-64k');
    if (request.commands.some((command) => ZERO.test(command.new))) {
        if (!advertised.has('delete-refs'))
            throw new UploadPackError('the receiving end does not support deleting refs');
        capabilities.push('delete-refs');
    }
    if (request.atomic) {
        if (!advertised.has('atomic'))
            throw new UploadPackError('the receiving end does not support --atomic push');
        capabilities.push('atomic');
    }
    if (request.pushOptions.length > 0) {
        if (!advertised.has('push-options'))
            throw new UploadPackError('the receiving end does not support push options');
        capabilities.push('push-options');
    }
    if (advertised.has('ofs-delta'))
        capabilities.push('ofs-delta');
    capabilities.push('agent=git/nimbus');
    return capabilities;
}
/** The request's body: the commands and options as pkt-lines, then the pack, as it comes. */
async function* requestBody(capabilities, request) {
    for (let i = 0; i < request.commands.length; i++) {
        const command = request.commands[i];
        yield pktLine(command.old + ' ' + command.new + ' ' + command.ref + (i === 0 ? '\0' + capabilities.join(' ') : '') + '\n');
    }
    yield encoder.encode('0000');
    if (request.pushOptions.length > 0) {
        for (const option of request.pushOptions)
            yield pktLine(option + '\n');
        yield encoder.encode('0000');
    }
    if (request.pack !== null)
        for await (const chunk of request.pack)
            yield chunk;
}
/** Push: the commands, the options and the pack in one request; receive-pack's report. */
export async function sendPack(options, advertisement, request) {
    if (request.commands.length === 0)
        throw new UploadPackError('a push updates at least one ref');
    const allDeletes = request.commands.every((command) => ZERO.test(command.new));
    if (allDeletes !== (request.pack === null)) {
        throw new PackFormatError(allDeletes ? 'a push of deletions only sends no pack' : 'a push of new values needs their pack');
    }
    const capabilities = pushCapabilities(advertisement.capabilities, request);
    const source = requestBody(capabilities, request);
    const body = new ReadableStream({
        async pull(controller) {
            const next = await source.next();
            if (next.done)
                controller.close();
            else
                controller.enqueue(next.value);
        },
        async cancel() {
            await source.return(undefined);
        },
    });
    // Not retried: a push's body is streamed once, and a retried push could apply twice.
    const doFetch = options.fetch ?? fetch;
    let response;
    try {
        response = await doFetch(repoUrl(options.url) + '/git-receive-pack', {
            method: 'POST',
            body,
            headers: headers(options, {
                'content-type': 'application/x-git-receive-pack-request',
                accept: 'application/x-git-receive-pack-result',
            }),
            signal: options.signal,
            // A streamed request body (fetch's half-duplex upload).
            duplex: 'half',
        });
    }
    catch (error) {
        throw new UploadPackError('the push failed: ' + (error instanceof Error ? error.message : String(error)));
    }
    if (!response.ok || !response.body) {
        const detail = response.body ? (await response.text()).slice(0, 300) : '';
        throw new UploadPackError('the push answered HTTP ' + response.status + (detail ? ': ' + detail : ''), response.status);
    }
    const reader = new PktReader(response.body.getReader(), options.stallMs);
    const lines = capabilities.includes('side-band-64k')
        ? await reportFromSideBand(reader, options.onProgress)
        : await reportLines(reader);
    return parseReport(lines);
}
/** The report's lines, read straight from the response (no side-band). */
async function reportLines(reader) {
    const lines = [];
    for (;;) {
        const payload = await reader.next();
        if (payload === undefined || payload === null)
            break;
        lines.push(text(payload));
    }
    return lines;
}
/** Band 1 of side-band-64k is the report, pkt-lines of its own; band 2 progress; band 3 a fatal error. */
async function reportFromSideBand(reader, onProgress) {
    let report = new Uint8Array(0);
    for (;;) {
        const payload = await reader.next();
        if (payload === undefined || payload === null)
            break;
        const band = payload[0];
        const data = payload.subarray(1);
        if (band === 1) {
            const merged = new Uint8Array(report.byteLength + data.byteLength);
            merged.set(report);
            merged.set(data, report.byteLength);
            report = merged;
        }
        else if (band === 2) {
            for (const line of new TextDecoder().decode(data).split(/\r|\n/))
                if (line && onProgress)
                    onProgress(line);
        }
        else if (band === 3) {
            throw new UploadPackError('the remote: ' + new TextDecoder().decode(data).trim());
        }
    }
    // The report's own pkt-lines.
    const lines = [];
    for (let at = 0; at + 4 <= report.byteLength;) {
        const length = parseInt(new TextDecoder().decode(report.subarray(at, at + 4)), 16);
        if (!Number.isInteger(length))
            throw new UploadPackError('a malformed push report');
        if (length === 0) {
            at += 4;
            continue;
        }
        lines.push(text(report.subarray(at + 4, at + length)));
        at += length;
    }
    return lines;
}
/** report-status: "unpack ok" or "unpack <reason>", then "ok <ref>" or "ng <ref> <reason>" for each. */
function parseReport(lines) {
    const [first, ...rest] = lines;
    if (first === undefined || !first.startsWith('unpack '))
        throw new UploadPackError('the remote sent no push report');
    const unpackStatus = first.slice('unpack '.length);
    const report = { unpack: unpackStatus === 'ok' ? { ok: true } : { ok: false, reason: unpackStatus }, refs: [] };
    for (const line of rest) {
        if (line.startsWith('ok ')) {
            report.refs.push({ ref: line.slice(3), ok: true });
        }
        else if (line.startsWith('ng ')) {
            const space = line.indexOf(' ', 3);
            report.refs.push(space < 0 ? { ref: line.slice(3), ok: false } : { ref: line.slice(3, space), ok: false, reason: line.slice(space + 1) });
        }
    }
    return report;
}
