/**
 * runtime/esm-loader-policy.ts — what Node 22's ES module loader decides
 * before any module is resolved or loaded, for both of Nimbus's loaders: the
 * portable one (substrate/lifo/node-compat/native-esm-loader.ts) and the
 * hosted one (worker runtime/node-shims.ts, which compiles these functions in
 * as ESM_LOADER_POLICY_SOURCE). Self-contained: no imports, so it compiles
 * into a guest preamble whole.
 */
/**
 * import(specifier, options)'s arguments as V8 reads them before the host
 * sees the call (isolate.cc RunHostImportModuleDynamicallyCallback and
 * GetImportAttributesFromArgument, Node 22): the specifier converted to a
 * string first; then `options`, an object or a function, its `with` read
 * once, an object or a function, and each of that's own enumerable string
 * keys read once, all of them before any is refused for not being a string.
 * Throws V8's TypeError for the first rule broken. The attributes are a
 * null-prototype record, so a `__proto__` attribute is one. The arguments
 * are whatever the program passed, so they are typed as such.
 */
export function importCallArguments(specifier, options) {
    if (typeof specifier === 'symbol')
        throw new TypeError('Cannot convert a Symbol value to a string');
    const text = String(specifier);
    const attributes = Object.create(null);
    if (options === undefined)
        return { specifier: text, attributes };
    if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
        throw new TypeError('The second argument to import() must be an object');
    }
    const given = Reflect.get(options, 'with');
    if (given === undefined)
        return { specifier: text, attributes };
    if (given === null || (typeof given !== 'object' && typeof given !== 'function')) {
        throw new TypeError("The 'assert' option must be an object");
    }
    let strings = true;
    for (const key of Object.keys(given)) {
        const value = Reflect.get(given, key);
        if (typeof value === 'string')
            attributes[key] = value;
        else
            strings = false;
    }
    if (!strings)
        throw new TypeError('Import assertion value must be a string');
    return { specifier: text, attributes };
}
/** The fetch standard's percent-decode: each %XX its byte, everything else its UTF-8 bytes. */
function percentDecode(text) {
    const encoded = new TextEncoder().encode(text);
    const bytes = new Uint8Array(encoded.length);
    let length = 0;
    const hex = (byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
    for (let index = 0; index < encoded.length; index++) {
        const byte = encoded[index];
        if (byte === 0x25 && index + 2 < encoded.length && hex(encoded[index + 1]) && hex(encoded[index + 2])) {
            bytes[length++] = parseInt(String.fromCharCode(encoded[index + 1], encoded[index + 2]), 16);
            index += 2;
        }
        else {
            bytes[length++] = byte;
        }
    }
    return bytes.subarray(0, length);
}
/**
 * A data: URL module as Node 22's loader reads it: its format by its MIME
 * type (get_format.js getDataProtocolModuleFormat, formats.js mimeToFormat:
 * text/ or application/javascript, with a UTF-8 charset or none, is a
 * module; application/json is JSON), and its source the body as the fetch
 * standard's data: URL processor reads it (the URL but its fragment: the
 * bytes after the first comma, percent-decoded, then base64-decoded when the
 * MIME type ends `;base64`) as UTF-8 text. A body that is not base64 is
 * Node's ERR_INVALID_URL.
 */
export function dataModule(url) {
    const parsed = new URL(url);
    const mime = /^([^/]+\/[^;,]+)(?:[^,]*?)(;base64)?,/.exec(parsed.pathname);
    const format = mime === null ? null
        : /^\s*(text|application)\/javascript\s*(;\s*charset=utf-?8\s*)?$/i.test(mime[1]) ? 'module'
            : mime[1] === 'application/json' ? 'json' : null;
    if (format === null)
        return { format, mime: mime?.[1] ?? null };
    parsed.hash = '';
    const input = parsed.href.slice('data:'.length);
    const comma = input.indexOf(',');
    let body = percentDecode(input.slice(comma + 1));
    // The MIME type trimmed of ASCII whitespace alone, as the fetch standard trims it.
    if (/; *base64$/i.test(input.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''))) {
        let isomorphic = '';
        for (const byte of body)
            isomorphic += String.fromCharCode(byte);
        let binary;
        try {
            binary = atob(isomorphic);
        }
        catch {
            throw Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL', input: url });
        }
        body = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    return { format, source: new TextDecoder().decode(body) };
}
