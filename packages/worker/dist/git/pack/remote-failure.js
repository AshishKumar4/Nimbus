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
    const parts = originalUrlParts(url);
    if (!parts)
        return url;
    return parts.scheme + parts.authority.slice(parts.authority.lastIndexOf('@') + 1) + parts.rest;
}
/** Git's URL grammar by original spans: never fold host case, remove default ports or rewrite escapes. */
function originalUrlParts(url) {
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(url)?.[0];
    if (!scheme)
        return null;
    let end = url.length;
    for (const delimiter of ['/', '?', '#']) {
        const found = url.indexOf(delimiter, scheme.length);
        if (found >= 0)
            end = Math.min(end, found);
    }
    return { scheme, authority: url.slice(scheme.length, end), rest: url.slice(end) };
}
/** The user name and password a URL's authority carries ('' for none). */
export function urlCredentials(url) {
    if (!URL.canParse(url))
        return { username: '', password: '' };
    const parsed = new URL(url);
    return { username: unescapeUserinfo(parsed.username), password: unescapeUserinfo(parsed.password) };
}
/** A URL's credentials form one pair and take precedence over the caller's pair, as git's transport does. */
export function selectRemoteCredentials(url, supplied = { username: '', password: '' }) {
    const embedded = urlCredentials(url);
    return embedded.username || embedded.password ? embedded : supplied;
}
/** Decode valid UTF-8 escape runs exactly as the Git HTTP transport does; keep stray/invalid escapes. */
function unescapeUserinfo(text) {
    return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
        try {
            return decodeURIComponent(run);
        }
        catch {
            return run;
        }
    });
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
    const parts = originalUrlParts(url);
    if (!parts)
        return anonymizeUrl(url);
    const host = parts.authority.slice(parts.authority.lastIndexOf('@') + 1);
    return parts.scheme + (username ? percentEncode(username) + '@' : '') + host;
}
/**
 * `text` (what a server sent, to be printed) with the credentials it may
 * echo taken out: each URL's user name and password, and every secret
 * offered (a password, a token) wherever it appears.
 */
export function redactCredentials(text, secrets) {
    return redactSecrets(text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1'), secrets);
}
/** Exact known secrets, wherever they appear; a credential prompt may still name a non-secret user. */
function redactSecrets(text, secrets) {
    let out = text;
    for (const secret of secrets)
        if (secret.length > 0)
            out = out.split(secret).join('<redacted>');
    return out;
}
/** Match raw characters or their UTF-8 percent encoding, without changing other bytes. */
function secretPattern(secret) {
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hex = (byte) => byte.toString(16).padStart(2, '0').replace(/[a-f]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
    const encoder = new TextEncoder();
    return new RegExp([...secret].map((character) => `(?:${escape(character)}|${[...encoder.encode(character)].map((byte) => '%' + hex(byte)).join('')})`).join(''), 'g');
}
/** Mask original data spans; path slashes, query separators and authority syntax never enter a match. */
function redactDestination(url, secrets, credentialPrompt = false) {
    const parts = originalUrlParts(url);
    if (!parts)
        return '<invalid remote URL>';
    const patterns = secrets.filter((secret) => secret.length > 0).map(secretPattern);
    const mask = (data) => patterns.reduce((text, pattern) => {
        // A raw match cannot begin/end inside an escape: the "2" in %20 is
        // encoding syntax, not the character "2" or any part of the secret.
        const boundaries = new Set([0]);
        for (let at = 0; at < text.length;) {
            at += /^%[0-9a-fA-F]{2}/.test(text.slice(at, at + 3)) ? 3 : 1;
            boundaries.add(at);
        }
        return text.replace(pattern, (match, offset) => boundaries.has(offset) && boundaries.has(offset + match.length) ? '<redacted>' : match);
    }, data);
    const at = parts.authority.lastIndexOf('@');
    const host = parts.authority.slice(at + 1);
    const username = at < 0 ? '' : parts.authority.slice(0, at).split(':', 1)[0];
    const authority = credentialPrompt && at >= 0 ? mask(username) + '@' + host : host;
    const hash = parts.rest.indexOf('#');
    const withoutHash = hash < 0 ? parts.rest : parts.rest.slice(0, hash);
    const query = withoutHash.indexOf('?');
    const path = query < 0 ? withoutHash : withoutHash.slice(0, query);
    const queryData = query < 0 ? '' : '?' + withoutHash.slice(query + 1).split(/([&=])/).map((token, index) => index % 2 ? token : mask(token)).join('');
    const fragment = hash < 0 ? '' : '#' + mask(parts.rest.slice(hash + 1));
    return parts.scheme + authority + path.split('/').map(mask).join('/') + queryData + fragment;
}
/**
 * git's lines for `failure` of the repository at `url` (as configured or
 * given), `credentials` what the request offered: the server's plain-text
 * message as `remote:` lines (credentials and `secrets` taken out), then
 * git's own.
 */
export function remoteFailureText(url, failure, credentials, secrets = []) {
    // remote-curl.c: the repository's URL ends with a slash, its credentials taken out.
    const shown = redactDestination(url.endsWith('/') ? url : url + '/', secrets);
    if (failure.kind === 'transport')
        return `fatal: unable to access '${shown}': ${redactCredentials(failure.detail, secrets)}\n`;
    // A 401 asks for what was not offered (credential_fill), and there is no terminal to ask at.
    if (failure.status === 401 && !credentials.password) {
        const what = credentials.username ? 'Password' : 'Username';
        const prompt = credentialDescription(url, credentials.username);
        const safePrompt = redactDestination(prompt, secrets, true);
        return `fatal: could not read ${what} for '${safePrompt}': terminal prompts disabled\n`;
    }
    const remote = redactCredentials(failure.message ?? '', secrets).trim();
    const lines = remote === '' ? '' : remote.split('\n').map((line) => `remote: ${line}\n`).join('');
    if (failure.status === 404)
        return `${lines}fatal: repository '${shown}' not found\n`;
    if (failure.status === 401)
        return `${lines}fatal: Authentication failed for '${shown}'\n`;
    return `${lines}fatal: unable to access '${shown}': The requested URL returned error: ${failure.status}\n`;
}
/** What git says of a remote that names neither a configured remote nor a repository (transport.c, connect.c). */
export function noSuchRemoteText(remote) {
    return `fatal: '${remote}' does not appear to be a git repository\n`
        + 'fatal: Could not read from remote repository.\n\n'
        + 'Please make sure you have the correct access rights\n'
        + 'and the repository exists.\n';
}
/** Whether an answer's type is text/plain, the only one git shows (show_http_message). */
function isPlainText(contentType) {
    return (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/plain';
}
/** A body's first MESSAGE_BYTES (what a failing answer's message is kept of), the rest left unread. */
async function readBounded(body) {
    const out = new Uint8Array(MESSAGE_BYTES);
    let size = 0;
    for await (const chunk of body) {
        const take = Math.min(chunk.byteLength, MESSAGE_BYTES - size);
        out.set(chunk.subarray(0, take), size);
        size += take;
        if (size === MESSAGE_BYTES)
            break;
    }
    return out.slice(0, size);
}
/** The message of an answer's body, when its type is text/plain; the body is read (or cancelled). */
export async function plainTextMessage(contentType, body) {
    if (body === null)
        return undefined;
    if (!isPlainText(contentType)) {
        await body.cancel();
        return undefined;
    }
    return new TextDecoder().decode(await readBounded(body));
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
            const body = response.body;
            const bytes = body && Symbol.asyncIterator in body ? await readBounded(body) : new Uint8Array(0);
            const headers = (response.headers ?? {});
            const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
            answered = { kind: 'status', status: response.statusCode, ...(isPlainText(contentType) ? { message: new TextDecoder().decode(bytes) } : {}) };
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
