import { resolve } from '../../utils/path.js';
import { isLoopbackHost } from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';
const SHORT_VALUE_OPTIONS = new Set(['X', 'H', 'd', 'o', 'w']);
const MAX_REDIRECTS = 20;
function createCurlImpl(kernel) {
    return async (ctx) => {
        const options = parseCurlArgs(ctx.args);
        let url = options.url;
        if (!url) {
            ctx.stderr.write('curl: no URL specified\n');
            ctx.stderr.write('Usage: curl [-fsSLI#] [-X method] [-H header] [-d data] [-o file] [-w format] url\n');
            return 1;
        }
        // Ensure URL has protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        if (kernel?.portRegistry) {
            const virtual = await resolveVirtualCurlResponse(kernel, ctx, options, url);
            if (virtual?.kind === 'response') {
                return handleCurlResponse(ctx, options, virtual.response);
            }
            if (virtual?.kind === 'external') {
                url = virtual.url;
            }
            if (virtual?.kind === 'error') {
                return virtual.exitCode;
            }
        }
        try {
            const requestSignal = createRequestSignal(ctx.signal, options.maxTimeSeconds);
            const fetchOptions = {
                method: options.method,
                headers: Object.keys(options.headers).length > 0 ? options.headers : undefined,
                body: options.data,
                redirect: options.followRedirects ? 'follow' : 'manual',
                signal: requestSignal.signal,
            };
            try {
                const response = await fetch(url, fetchOptions);
                const effectiveUrl = response.url || url;
                // Body streams to stdout as it arrives (SSE/chunked responses flow
                // live); an -o file needs the whole payload for a single VFS write.
                const body = options.outputFile
                    ? new Uint8Array(await response.arrayBuffer())
                    : response.body ?? '';
                return await handleCurlResponse(ctx, options, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: headersToRecord(response.headers),
                    body,
                    url: effectiveUrl,
                });
            }
            finally {
                requestSignal.cleanup();
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === CURL_TIMEOUT_ERROR) {
                ctx.stderr.write(`curl: operation timed out after ${options.maxTimeSeconds} seconds\n`);
            }
            else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
                ctx.stderr.write(`curl: (7) Failed to connect to ${url}\n`);
                ctx.stderr.write(`Note: This may be a CORS restriction. The target server must allow cross-origin requests.\n`);
            }
            else {
                ctx.stderr.write(`curl: ${msg}\n`);
            }
            return 7;
        }
    };
}
const CURL_TIMEOUT_ERROR = 'curl request timeout';
function parseCurlArgs(args) {
    const options = {
        method: 'GET',
        headers: {},
        silent: false,
        showError: false,
        followRedirects: false,
        fail: false,
        headOnly: false,
        progressBar: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg === '--') {
            if (args[i + 1] !== undefined)
                options.url = args[i + 1];
            break;
        }
        if (arg.startsWith('--')) {
            const consumed = parseLongOption(options, arg, args, i);
            i += consumed;
            continue;
        }
        if (arg.startsWith('-') && arg !== '-') {
            const consumed = parseShortOptions(options, arg, args, i);
            i += consumed;
            continue;
        }
        options.url = arg;
    }
    return options;
}
function parseLongOption(options, arg, args, index) {
    const eqIdx = arg.indexOf('=');
    const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
    const readValue = () => {
        if (inlineValue !== undefined)
            return { value: inlineValue, consumed: 0 };
        return { value: args[index + 1] ?? '', consumed: 1 };
    };
    switch (name) {
        case '--request': {
            const { value, consumed } = readValue();
            options.method = value || 'GET';
            return consumed;
        }
        case '--header': {
            const { value, consumed } = readValue();
            addHeader(options, value);
            return consumed;
        }
        case '--data':
        case '--data-raw':
        case '--data-binary': {
            const { value, consumed } = readValue();
            options.data = value;
            if (options.method === 'GET')
                options.method = 'POST';
            return consumed;
        }
        case '--output': {
            const { value, consumed } = readValue();
            options.outputFile = value;
            return consumed;
        }
        case '--write-out': {
            const { value, consumed } = readValue();
            options.writeOut = value;
            return consumed;
        }
        case '--trace-ascii': {
            const { value, consumed } = readValue();
            options.traceAscii = value;
            return consumed;
        }
        case '--max-time':
        case '--connect-timeout': {
            const { value, consumed } = readValue();
            options.maxTimeSeconds = parsePositiveNumber(value);
            return consumed;
        }
        case '--silent':
            options.silent = true;
            return 0;
        case '--show-error':
            options.showError = true;
            return 0;
        case '--location':
            options.followRedirects = true;
            return 0;
        case '--fail':
            options.fail = true;
            return 0;
        case '--head':
            options.headOnly = true;
            options.method = 'HEAD';
            return 0;
        case '--progress-bar':
            options.progressBar = true;
            return 0;
        default:
            return 0;
    }
}
function parseShortOptions(options, arg, args, index) {
    const chars = arg.slice(1);
    for (let j = 0; j < chars.length; j++) {
        const flag = chars[j];
        if (!flag)
            continue;
        if (SHORT_VALUE_OPTIONS.has(flag)) {
            const rest = chars.slice(j + 1);
            const value = rest || args[index + 1] || '';
            applyShortValueOption(options, flag, value);
            return rest ? 0 : 1;
        }
        applyShortBooleanOption(options, flag);
    }
    return 0;
}
function applyShortBooleanOption(options, flag) {
    switch (flag) {
        case 's':
            options.silent = true;
            break;
        case 'S':
            options.showError = true;
            break;
        case 'L':
            options.followRedirects = true;
            break;
        case 'f':
            options.fail = true;
            break;
        case 'I':
            options.headOnly = true;
            options.method = 'HEAD';
            break;
        case '#':
            options.progressBar = true;
            break;
    }
}
function applyShortValueOption(options, flag, value) {
    switch (flag) {
        case 'X':
            options.method = value || 'GET';
            break;
        case 'H':
            addHeader(options, value);
            break;
        case 'd':
            options.data = value;
            if (options.method === 'GET')
                options.method = 'POST';
            break;
        case 'o':
            options.outputFile = value;
            break;
        case 'w':
            options.writeOut = value;
            break;
    }
}
function addHeader(options, header) {
    const colonIdx = header.indexOf(':');
    if (colonIdx === -1)
        return;
    options.headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
}
async function resolveVirtualCurlResponse(kernel, ctx, options, startUrl) {
    let currentUrl = startUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await fetchVirtualCurlResponse(kernel, ctx, options, currentUrl);
        if (!response) {
            return redirects === 0 ? null : { kind: 'external', url: currentUrl };
        }
        if ('exitCode' in response) {
            return { kind: 'error', exitCode: response.exitCode };
        }
        if (options.followRedirects && isRedirectStatus(response.status)) {
            const location = getHeader(response.headers, 'location');
            if (location) {
                try {
                    currentUrl = new URL(location, currentUrl).toString();
                    cancelStreamBody(response.body);
                    continue;
                }
                catch {
                    return { kind: 'response', response };
                }
            }
        }
        return { kind: 'response', response };
    }
    ctx.stderr.write(`curl: (47) Maximum (${MAX_REDIRECTS}) redirects followed\n`);
    return { kind: 'error', exitCode: 47 };
}
async function fetchVirtualCurlResponse(kernel, ctx, options, url) {
    let requestUrl;
    try {
        requestUrl = new URL(url);
    }
    catch {
        return null;
    }
    let host = requestUrl.hostname;
    const port = requestUrl.port ? Number(requestUrl.port) : (requestUrl.protocol === 'http:' ? 80 : 443);
    if (kernel.networkStack && !isLoopbackHost(host)) {
        host = kernel.networkStack.getDNS().lookup(host)?.value ?? host;
    }
    if (!isLoopbackHost(host)) {
        return null;
    }
    const handler = kernel.portRegistry.get(port);
    if (handler) {
        const vReq = {
            method: options.method,
            url: requestUrl.pathname + requestUrl.search,
            headers: options.headers,
            body: options.data || '',
        };
        const vRes = {
            statusCode: 200,
            headers: {},
            body: '',
        };
        handler(vReq, vRes);
        if (vRes._donePromise) {
            const result = await waitForSignalOrTimeout(vRes._donePromise, ctx.signal, 30_000);
            if (result.type === 'aborted') {
                return { exitCode: 130 };
            }
            if (result.type === 'timeout') {
                ctx.stderr.write('curl: request timeout after 30s\n');
                return { exitCode: 7 };
            }
        }
        return {
            status: vRes.statusCode,
            statusText: statusText(vRes.statusCode),
            headers: vRes.headers,
            body: vRes.body,
            url,
        };
    }
    if (kernel.routeLoopback) {
        const hasBody = options.method !== 'GET' && options.method !== 'HEAD' && options.data !== undefined;
        const request = new Request(requestUrl, {
            method: options.method,
            headers: options.headers,
            body: hasBody ? options.data : undefined,
            signal: ctx.signal,
        });
        const response = await kernel.routeLoopback(port, request);
        if (response) {
            return {
                status: response.status,
                statusText: response.statusText,
                headers: headersToRecord(response.headers),
                // Stream to stdout as bytes arrive (a facet's SSE flows live);
                // an -o file needs the whole payload for a single VFS write.
                body: options.outputFile
                    ? new Uint8Array(await response.arrayBuffer())
                    : response.body ?? '',
                url: response.url || url,
            };
        }
    }
    ctx.stderr.write(`curl: (7) Failed to connect to ${requestUrl.hostname} port ${port}\n`);
    return { exitCode: 7 };
}
async function handleCurlResponse(ctx, options, response) {
    const failed = options.fail && response.status >= 400;
    if (options.headOnly) {
        cancelStreamBody(response.body);
        if (!failed) {
            await writeCurlOutput(ctx, options, curlHeaders(response));
        }
        writeCurlFailure(ctx, options, response);
        writeCurlWriteOut(ctx, options, response);
        return curlExitCode(options, response.status);
    }
    if (!failed) {
        await writeCurlOutput(ctx, options, response.body);
        if (options.outputFile && !options.silent) {
            const size = bodySize(response.body);
            ctx.stderr.write(`  % Total    % Received\n`);
            ctx.stderr.write(`  ${size}    ${size}\n`);
        }
    }
    else {
        cancelStreamBody(response.body);
    }
    writeCurlFailure(ctx, options, response);
    writeCurlWriteOut(ctx, options, response);
    return curlExitCode(options, response.status);
}
function cancelStreamBody(body) {
    if (body instanceof ReadableStream) {
        body.cancel().catch(() => { });
    }
}
function writeCurlFailure(ctx, options, response) {
    if (options.fail && options.showError && response.status >= 400) {
        ctx.stderr.write(`curl: (${response.status}) The requested URL returned error: ${response.status}\n`);
    }
}
async function writeCurlOutput(ctx, options, body) {
    if (!options.outputFile) {
        if (typeof body === 'string') {
            ctx.stdout.write(body);
            if (!body.endsWith('\n'))
                ctx.stdout.write('\n');
        }
        else if (body instanceof Uint8Array) {
            ctx.stdout.write(new TextDecoder().decode(body));
        }
        else {
            await streamCurlBodyToStdout(ctx, body);
        }
        return;
    }
    if (options.outputFile === '/dev/null') {
        cancelStreamBody(body);
        return;
    }
    if (body instanceof ReadableStream) {
        // Streams reach here only via the no-outputFile construction paths;
        // fail loud rather than silently writing a broken file.
        cancelStreamBody(body);
        throw new Error('curl: internal error — streaming body cannot be written to an output file');
    }
    ctx.vfs.writeFile(resolve(ctx.cwd, options.outputFile), body);
}
/**
 * Relay a streaming body to stdout chunk-by-chunk as bytes arrive — this is
 * what lets `curl -N` against an SSE/chunked endpoint display live instead of
 * flushing everything at stream end. Ctrl-C (ctx.signal) cancels the read.
 */
async function streamCurlBodyToStdout(ctx, body) {
    const reader = body.getReader();
    const onAbort = () => { reader.cancel().catch(() => { }); };
    if (ctx.signal.aborted) {
        onAbort();
        return;
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const decoder = new TextDecoder();
    let tail = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const text = decoder.decode(value, { stream: true });
            if (text) {
                ctx.stdout.write(text);
                tail = text;
            }
        }
        const flushed = decoder.decode();
        if (flushed) {
            ctx.stdout.write(flushed);
            tail = flushed;
        }
        if (tail && !tail.endsWith('\n'))
            ctx.stdout.write('\n');
    }
    finally {
        ctx.signal.removeEventListener('abort', onAbort);
    }
}
function writeCurlWriteOut(ctx, options, response) {
    if (!options.writeOut)
        return;
    ctx.stdout.write(formatWriteOut(options.writeOut, response));
}
function formatWriteOut(template, response) {
    return template
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/%\{http_code\}/g, String(response.status))
        .replace(/%\{response_code\}/g, String(response.status))
        .replace(/%\{url_effective\}/g, response.url);
}
function headersToRecord(headers) {
    const record = {};
    headers.forEach((value, key) => {
        record[key] = value;
    });
    return record;
}
function curlHeaders(response) {
    const lines = [`HTTP/${response.status} ${response.statusText}`];
    for (const [key, value] of Object.entries(response.headers)) {
        lines.push(`${key}: ${value}`);
    }
    return lines.join('\n') + '\n';
}
function curlExitCode(options, status) {
    return options.fail && status >= 400 ? 22 : 0;
}
function isRedirectStatus(status) {
    return status >= 300 && status < 400;
}
function getHeader(headers, name) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted)
            return value;
    }
    return undefined;
}
function bodySize(body) {
    if (typeof body === 'string')
        return body.length;
    return body instanceof Uint8Array ? body.byteLength : 0;
}
function statusText(status) {
    switch (status) {
        case 200: return 'OK';
        case 201: return 'Created';
        case 204: return 'No Content';
        case 301: return 'Moved Permanently';
        case 302: return 'Found';
        case 303: return 'See Other';
        case 307: return 'Temporary Redirect';
        case 308: return 'Permanent Redirect';
        case 400: return 'Bad Request';
        case 401: return 'Unauthorized';
        case 403: return 'Forbidden';
        case 404: return 'Not Found';
        case 500: return 'Internal Server Error';
        default: return '';
    }
}
function parsePositiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function createRequestSignal(parent, timeoutSeconds) {
    if (timeoutSeconds === undefined) {
        return { signal: parent, cleanup: () => { } };
    }
    const controller = new AbortController();
    let parentListenerAdded = false;
    const timeout = setTimeout(() => {
        controller.abort(new Error(CURL_TIMEOUT_ERROR));
    }, timeoutSeconds * 1000);
    const abortFromParent = () => {
        controller.abort(parent.reason);
    };
    if (parent.aborted) {
        abortFromParent();
    }
    else {
        parent.addEventListener('abort', abortFromParent, { once: true });
        parentListenerAdded = true;
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeout);
            if (parentListenerAdded)
                parent.removeEventListener('abort', abortFromParent);
        },
    };
}
export function createCurlCommand(kernel) {
    return createCurlImpl(kernel);
}
// Default command (no kernel -- always uses fetch)
const command = createCurlImpl();
export default command;
