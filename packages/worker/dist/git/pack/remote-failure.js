/**
 * git/pack/remote-failure.ts — a git server that could not be reached, or
 * refused, as git says it (remote-curl.c discover_refs, http.c
 * handle_curl_result).
 *
 * The facet records what failed (remoteFailureOf): the transport (no
 * answer), or the HTTP status the server answered with, and the text it
 * sent with it when that is plain text. The command says it in git's words
 * (remoteFailureText), and exits as git does (128; a pull, whose fetch is
 * git's child, 1).
 */
/** The most of a failing answer's body kept for its message. */
const MESSAGE_BYTES = 64 * 1024;
/**
 * transport_anonymize_url: `url` without the user name and password its
 * authority may carry.
 */
export function anonymizeUrl(url) {
    const scheme = url.indexOf('://');
    if (scheme < 0)
        return url;
    const start = scheme + 3;
    const slash = url.indexOf('/', start);
    const end = slash < 0 ? url.length : slash;
    const at = url.lastIndexOf('@', end - 1);
    return at < start ? url : url.slice(0, start) + url.slice(at + 1);
}
/** The user name and password a URL's authority carries ('' for none). */
export function urlCredentials(url) {
    const scheme = url.indexOf('://');
    if (scheme < 0)
        return { username: '', password: '' };
    const start = scheme + 3;
    const slash = url.indexOf('/', start);
    const end = slash < 0 ? url.length : slash;
    const at = url.lastIndexOf('@', end - 1);
    if (at < start)
        return { username: '', password: '' };
    const info = url.slice(start, at);
    const colon = info.indexOf(':');
    return colon < 0 ? { username: info, password: '' } : { username: info.slice(0, colon), password: info.slice(colon + 1) };
}
/** strbuf_add_percentencode with STRBUF_ENCODE_SLASH: every byte but [A-Za-z0-9-_.~] as %XX. */
function percentEncode(text) {
    let out = '';
    for (const byte of new TextEncoder().encode(text)) {
        const c = String.fromCharCode(byte);
        out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
}
/**
 * credential_format: what a credential prompt names, the protocol, the user
 * name (if known) and the host of `url`.
 */
function credentialDescription(url, username) {
    const scheme = url.indexOf('://');
    if (scheme < 0)
        return url;
    const start = scheme + 3;
    const slash = url.indexOf('/', start);
    const host = anonymizeUrl(url.slice(0, slash < 0 ? url.length : slash)).slice(start);
    return url.slice(0, start) + (username ? percentEncode(username) + '@' : '') + host;
}
/**
 * `text` (what a server sent, to be printed) with the credentials it may
 * echo taken out: each URL's user name and password, and every secret
 * offered (a password, a token) wherever it appears.
 */
export function redactCredentials(text, secrets) {
    let out = text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1');
    for (const secret of secrets)
        if (secret.length > 0)
            out = out.split(secret).join('<redacted>');
    return out;
}
/**
 * git's lines for `failure` of the repository at `url` (as configured or
 * given), `credentials` what the request offered: the server's plain-text
 * message as `remote:` lines (credentials and `secrets` taken out), then
 * git's own.
 */
export function remoteFailureText(url, failure, credentials, secrets = []) {
    // remote-curl.c: the repository's URL ends with a slash, its credentials taken out.
    const shown = anonymizeUrl(url.endsWith('/') ? url : url + '/');
    if (failure.kind === 'transport')
        return `fatal: unable to access '${shown}': ${redactCredentials(failure.detail, secrets)}\n`;
    // A 401 asks for what was not offered (credential_fill), and there is no terminal to ask at.
    if (failure.status === 401 && !credentials.password) {
        const what = credentials.username ? 'Password' : 'Username';
        return `fatal: could not read ${what} for '${credentialDescription(url, credentials.username)}': terminal prompts disabled\n`;
    }
    const remote = redactCredentials(failure.message ?? '', secrets).trim();
    const lines = remote === '' ? '' : remote.split('\n').map((line) => `remote: ${line}\n`).join('');
    if (failure.status === 404)
        return `${lines}fatal: repository '${shown}' not found\n`;
    if (failure.status === 401)
        return `${lines}fatal: Authentication failed for '${shown}'\n`;
    return `${lines}fatal: unable to access '${shown}': The requested URL returned error: ${failure.status}\n`;
}
/** The message of an answer's body, when its type is text/plain (show_http_message); the body is read. */
export async function plainTextMessage(contentType, body) {
    if (body === null)
        return undefined;
    const plain = (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/plain';
    if (!plain) {
        await body.cancel();
        return undefined;
    }
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
        size += value.byteLength;
        if (size >= MESSAGE_BYTES) {
            await reader.cancel();
            break;
        }
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk.subarray(0, Math.min(chunk.byteLength, size - at)), at);
        at += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes.subarray(0, Math.min(size, MESSAGE_BYTES)));
}
/**
 * What `error`, the facet's failure, says failed at the git server: an
 * UploadPackError's (a clone's own requests), or cf-git's through `http`;
 * undefined when it is not the server's failure.
 */
export function remoteFailureOf(error, http) {
    // An UploadPackError carries its own (upload-pack.ts).
    if (error instanceof Error && error.name === 'UploadPackError')
        return error.failure;
    return http?.failureOf(error);
}
/** A body of `bytes` again, as cf-git reads a response body (an async iterable of chunks). */
async function* replay(bytes) {
    yield bytes;
}
/** Bytes from cf-git's response body (an async iterable), up to MESSAGE_BYTES. */
async function collect(body) {
    const chunks = [];
    let size = 0;
    if (body && Symbol.asyncIterator in body) {
        for await (const chunk of body) {
            chunks.push(chunk);
            size += chunk.byteLength;
            if (size >= MESSAGE_BYTES)
                break;
        }
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}
/**
 * `http` with each failure kept: a request that threw (the transport: that
 * error), and an answer with a failing status (its status, and its body when
 * plain text, which cf-git still reads after). cf-git's HttpError for that
 * status, or the transport's own error, is then known for what it is.
 */
export function observedGitHttp(http) {
    let thrown = null;
    let answered = null;
    return {
        async request(req) {
            let response;
            try {
                response = await http.request(req);
            }
            catch (error) {
                thrown = { error, failure: { kind: 'transport', detail: error instanceof Error ? error.message : String(error) } };
                throw error;
            }
            if (response.statusCode < 400)
                return response;
            const bytes = await collect(response.body);
            const headers = (response.headers ?? {});
            const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
            const plain = contentType.split(';')[0].trim().toLowerCase() === 'text/plain';
            answered = { kind: 'status', status: response.statusCode, ...(plain ? { message: new TextDecoder().decode(bytes) } : {}) };
            return { ...response, body: replay(bytes) };
        },
        failureOf(error) {
            if (thrown !== null && thrown.error === error)
                return thrown.failure;
            // isomorphic-git's HttpError: the status the server answered.
            const code = error && typeof error === 'object' ? error.code : undefined;
            const status = error && typeof error === 'object' ? error.data?.statusCode : undefined;
            if (code === 'HttpError' && typeof status === 'number') {
                return answered !== null && answered.status === status ? answered : { kind: 'status', status };
            }
            return undefined;
        },
    };
}
