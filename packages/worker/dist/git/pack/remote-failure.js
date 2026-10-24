/**
 * git/pack/remote-failure.ts — a git server that could not be reached, or
 * refused, as git says it (remote-curl.c discover_refs and run_slot, http.c
 * handle_curl_result).
 *
 * The facet records what failed (remoteFailureOf): for the discovery, the
 * transport (no answer), or the HTTP status the server answered with, and
 * the text it sent with it when that is plain text; for the request for the
 * pack (git's RPC, a POST), the status or the transport alone, its body
 * never read, as git discards it. Every failing answer is taken in by one
 * capture (answeredFailure). The command says it in git's words, the
 * credentials it offered taken out (remoteFailureText), and exits as git
 * does (128; a pull, whose fetch is git's child, 1).
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
/** Decode a data span to bytes and retain the original character range of every byte. */
function redactUrlSpan(text, secrets) {
    const encoder = new TextEncoder();
    const bytes = [], starts = [], ends = [];
    const hex = (code) => code >= 48 && code <= 57 ? code - 48
        : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
    for (let at = 0; at < text.length;) {
        const begin = at;
        const high = hex(text.charCodeAt(at + 1)), low = hex(text.charCodeAt(at + 2));
        if (text[at] === '%' && high >= 0 && low >= 0) {
            at += 3;
            bytes.push(high * 16 + low);
            starts.push(begin);
            ends.push(at);
        }
        else {
            const character = String.fromCodePoint(text.codePointAt(at));
            at += character.length;
            for (const byte of encoder.encode(character)) {
                bytes.push(byte);
                starts.push(begin);
                ends.push(at);
            }
        }
    }
    const matches = [];
    for (const secret of secrets) {
        if (secret.length === 0)
            continue;
        for (let at = 0; at <= bytes.length - secret.length; at++) {
            let size = 0;
            while (size < secret.length && bytes[at + size] === secret[size])
                size++;
            if (size === secret.length)
                matches.push({ start: starts[at], end: ends[at + size - 1] });
        }
    }
    matches.sort((a, b) => a.start - b.start || a.end - b.end);
    const ranges = [];
    for (const match of matches) {
        const last = ranges.at(-1);
        if (last && match.start <= last.end)
            last.end = Math.max(last.end, match.end);
        else
            ranges.push({ ...match });
    }
    let output = '', copied = 0;
    for (const range of ranges) {
        output += text.slice(copied, range.start) + '<redacted>';
        copied = range.end;
    }
    return output + text.slice(copied);
}
/** Mask original data spans; path slashes, query separators and authority syntax never enter a match. */
function redactDestination(url, secrets, credentialPrompt = false) {
    const parts = originalUrlParts(url);
    if (!parts)
        return '<invalid remote URL>';
    const encoder = new TextEncoder();
    const secretBytes = secrets.filter((secret) => secret.length > 0).map((secret) => encoder.encode(secret));
    const mask = (data) => redactUrlSpan(data, secretBytes);
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
 * git's own. `hint`, a host's word on where a credential comes from
 * (NIMBUS_GIT_CREDENTIAL_HINT), on its own line before the `fatal:` of a 401
 * that offered none, and only then.
 */
export function remoteFailureText(url, failure, credentials, secrets = [], hint) {
    // remote-curl.c: the repository's URL ends with a slash, its credentials taken out.
    const shown = redactDestination(url.endsWith('/') ? url : url + '/', secrets);
    if (failure.kind === 'transport')
        return `fatal: unable to access '${shown}': ${redactCredentials(failure.detail, secrets)}\n`;
    // A 401 asks for what was not offered (credential_fill), and there is no terminal to ask at.
    if (failure.status === 401 && !credentials.password) {
        const what = credentials.username ? 'Password' : 'Username';
        const prompt = credentialDescription(url, credentials.username);
        const safePrompt = redactDestination(prompt, secrets, true);
        const told = hint === undefined || hint.trim() === '' ? '' : `${hint.replace(/\n+$/, '')}\n`;
        return `${told}fatal: could not read ${what} for '${safePrompt}': terminal prompts disabled\n`;
    }
    if (failure.kind === 'rpc') {
        // run_slot's report, and fetch-pack's on finding nothing to read.
        const reason = failure.status === null ? failure.detail : `HTTP ${failure.status} curl 22 ${failure.detail}`;
        return `error: RPC failed; ${redactCredentials(reason, secrets)}\nfatal: the remote end hung up unexpectedly\n`;
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
/**
 * The failure an answer with a failing `status` is, its body read or let
 * go: a discovery's message is its body's first MESSAGE_BYTES when that is
 * text/plain; the request for the pack's body is never read (rpc_in).
 */
export async function answeredFailure(request, status, contentType, body) {
    if (request === 'rpc' || !isPlainText(contentType)) {
        await body?.[Symbol.asyncIterator]().return?.();
        // normalize_curl_result's words for a failing status.
        return request === 'rpc' ? { kind: 'rpc', status, detail: `The requested URL returned error: ${status}` } : { kind: 'status', status };
    }
    if (!body)
        return { kind: 'status', status };
    return { kind: 'status', status, message: new TextDecoder().decode(await readBounded(body)) };
}
/** No answer to `request`: the transport's words for why. */
export function transportFailure(request, detail) {
    return request === 'rpc' ? { kind: 'rpc', status: null, detail } : { kind: 'transport', detail };
}
/**
 * What `error`, the facet's failure, says failed at the git server: an
 * UploadPackError's (Nimbus's requests: upload-pack.ts, receive-pack.ts);
 * undefined when it is not the server's failure.
 */
export function remoteFailureOf(error) {
    if (error instanceof Error && error.name === 'UploadPackError')
        return error.failure;
    return undefined;
}
