/**
 * document-policy.ts — what a guest document's response headers say about
 * cross-origin isolation.
 *
 * The port registry sees every response a guest server sends, so it reads
 * the policy off each navigation response and reports it with the port
 * (`PortRegistry.stats`). The session shell decides from that what the
 * preview pane can offer (worker `_shared/preview-isolation.ts`), without
 * asking the guest again and without parsing headers in the browser.
 *
 * Each header is parsed the way the browser obtains it, so the report says
 * what the browser will do with the same bytes:
 *   - COEP and COOP are Structured Field items (RFC 8941); a value that does
 *     not parse, or whose item is not one of the policy tokens, is the
 *     default. https://html.spec.whatwg.org/multipage/browsers.html#obtain-an-embedder-policy
 *     https://html.spec.whatwg.org/multipage/browsers.html#obtain-coop
 *   - CORP is compared byte for byte.
 *     https://fetch.spec.whatwg.org/#cross-origin-resource-policy-internal-check
 */
export function documentPolicyOf(headers) {
    const embedder = headers.get('Cross-Origin-Embedder-Policy');
    const opener = headers.get('Cross-Origin-Opener-Policy');
    const embedderToken = embedder === null ? null : parseStructuredItemToken(embedder);
    const openerToken = opener === null ? null : parseStructuredItemToken(opener);
    const resource = headers.get('Cross-Origin-Resource-Policy');
    return {
        embedderPolicy: embedderToken === 'require-corp' || embedderToken === 'credentialless' ? embedderToken : 'unsafe-none',
        openerPolicy: openerToken === 'same-origin' || openerToken === 'same-origin-allow-popups' || openerToken === 'noopener-allow-popups'
            ? openerToken
            : 'unsafe-none',
        resourcePolicy: resource === 'same-origin' || resource === 'same-site' || resource === 'cross-origin' ? resource : null,
    };
}
// ── RFC 8941 item parsing ────────────────────────────────────────────────
//
// Only as much of Structured Field Values as deciding "is this item the token
// X" needs: the whole item is parsed, parameters and all, because a value that
// fails to parse anywhere is not the token either.
// https://www.rfc-editor.org/rfc/rfc8941#name-parsing-structured-fields
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;
class StructuredFieldCursor {
    input;
    position = 0;
    constructor(input) {
        this.input = input;
    }
    get done() { return this.position >= this.input.length; }
    peek() { return this.input.charAt(this.position); }
    take() { return this.input.charAt(this.position++); }
    skipSpaces() { while (this.peek() === ' ')
        this.position++; }
}
/** The bare item of an sf-item when it is a token, else null (not a token, or no valid item at all). */
function parseStructuredItemToken(value) {
    const cursor = new StructuredFieldCursor(value);
    cursor.skipSpaces();
    const item = parseBareItem(cursor);
    if (item === undefined || !parseParameters(cursor))
        return null;
    cursor.skipSpaces();
    if (!cursor.done)
        return null;
    return item.kind === 'token' ? item.value : null;
}
function parseBareItem(cursor) {
    const first = cursor.peek();
    if (first === '-' || (first >= '0' && first <= '9'))
        return parseNumber(cursor) ? { kind: 'other' } : undefined;
    if (first === '"')
        return parseString(cursor) ? { kind: 'other' } : undefined;
    if (first === ':')
        return parseByteSequence(cursor) ? { kind: 'other' } : undefined;
    if (first === '?') {
        cursor.take();
        const bit = cursor.take();
        return bit === '0' || bit === '1' ? { kind: 'other' } : undefined;
    }
    if (first === '*' || /[A-Za-z]/.test(first)) {
        let token = cursor.take();
        while (!cursor.done && TCHAR.test(cursor.peek()))
            token += cursor.take();
        return { kind: 'token', value: token };
    }
    return undefined;
}
function parseNumber(cursor) {
    if (cursor.peek() === '-')
        cursor.take();
    let integerDigits = 0;
    let fractionDigits = -1;
    while (!cursor.done) {
        const char = cursor.peek();
        if (char >= '0' && char <= '9') {
            cursor.take();
            if (fractionDigits >= 0)
                fractionDigits++;
            else
                integerDigits++;
        }
        else if (char === '.' && fractionDigits < 0) {
            if (integerDigits > 12)
                return false;
            cursor.take();
            fractionDigits = 0;
        }
        else {
            break;
        }
    }
    if (integerDigits === 0)
        return false;
    if (fractionDigits < 0)
        return integerDigits <= 15;
    return fractionDigits >= 1 && fractionDigits <= 3;
}
function parseString(cursor) {
    cursor.take();
    while (!cursor.done) {
        const char = cursor.take();
        if (char === '\\') {
            const escaped = cursor.take();
            if (escaped !== '"' && escaped !== '\\')
                return false;
        }
        else if (char === '"') {
            return true;
        }
        else if (char < ' ' || char > '~') {
            return false;
        }
    }
    return false;
}
function parseByteSequence(cursor) {
    cursor.take();
    while (!cursor.done) {
        const char = cursor.take();
        if (char === ':')
            return true;
        if (!BASE64_CHAR.test(char))
            return false;
    }
    return false;
}
function parseParameters(cursor) {
    while (cursor.peek() === ';') {
        cursor.take();
        cursor.skipSpaces();
        if (!KEY_START.test(cursor.peek()))
            return false;
        cursor.take();
        while (!cursor.done && KEY_CHAR.test(cursor.peek()))
            cursor.take();
        if (cursor.peek() === '=') {
            cursor.take();
            if (parseBareItem(cursor) === undefined)
                return false;
        }
    }
    return true;
}
