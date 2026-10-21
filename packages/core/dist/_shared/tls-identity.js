/**
 * tls-identity.ts — tls.checkServerIdentity as Node v22.23.4's lib/tls.js
 * makes it (checkServerIdentity, check, splitHost, unfqdn,
 * splitEscapedAltNames), over src/cares_wrap.cc CanonicalizeIP and libuv's
 * inet_pton and inet_ntop (deps/uv/src/inet.c), ported line for line.
 * scripts/bundle-facet-workers.mjs compiles it into the guest's shims
 * (TLS_IDENTITY_PREAMBLE), whose node:tls answers checkServerIdentity with
 * it. workerd's is an older Node's: it matched a host that is an IP address
 * only once IDNA maps it ('127.1') against a certificate for 127.0.0.1, and
 * a DNS name as written rather than in its ASCII form.
 *
 * What lib/tls.js takes from its primordials, and what the binding does in
 * C, runs on the built-ins captured before any program code
 * (primordials.ts); the rest calls the methods a program can replace, as
 * lib/tls.js does. What Node reads from its other modules (lib/internal/net.js
 * isIP, lib/internal/url.js domainToASCII) the caller gives.
 */
import { tlsCertAltnameFormat, tlsCertAltnameInvalid } from './node-error.js';
import { arrayIsArray, arrayJoin, JSONParse, NumberPrototypeToString, reflectApply, stringCharCodeAt, StringFromCharCode, stringIndexOf, stringSlice, } from './primordials.js';
function unfqdn(host) {
    return host.replace(/[.]$/, '');
}
// String#toLowerCase() is locale-sensitive, so only A-Z are lowered.
function splitHost(host) {
    return unfqdn(host).replace(/[A-Z]/g, (c) => StringFromCharCode(32 + c.charCodeAt(0))).split('.');
}
function check(hostParts, pattern, wildcards) {
    // Empty strings, null, undefined, etc. never match.
    if (!pattern)
        return false;
    const patternParts = splitHost(pattern);
    if (hostParts.length !== patternParts.length)
        return false;
    // Pattern has empty components, e.g. "bad..example.com".
    if (patternParts.includes(''))
        return false;
    // A U-label, a control character or a blank never matches.
    if (patternParts.some((s) => /[^\u0021-\u007F]/u.test(s)))
        return false;
    // Check host parts from right to left first.
    for (let i = hostParts.length - 1; i > 0; i -= 1) {
        if (hostParts[i] !== patternParts[i])
            return false;
    }
    const hostSubdomain = hostParts[0];
    const patternSubdomain = patternParts[0];
    const patternSubdomainParts = patternSubdomain.split('*', 3);
    // No wildcard, or an A-label, which RFC 6125 matches verbatim.
    if (patternSubdomainParts.length === 1 || patternSubdomain.includes('xn--'))
        return hostSubdomain === patternSubdomain;
    if (!wildcards)
        return false;
    // More than one wildcard is always wrong.
    if (patternSubdomainParts.length > 2)
        return false;
    // *.tld wildcards are not allowed.
    if (patternParts.length <= 2)
        return false;
    const { 0: prefix, 1: suffix } = patternSubdomainParts;
    if (prefix.length + suffix.length > hostSubdomain.length)
        return false;
    if (!hostSubdomain.startsWith(prefix))
        return false;
    if (!hostSubdomain.endsWith(suffix))
        return false;
    return true;
}
// A JSON string literal (ECMA-404, RFC 8259), exactly: how far a quoted name runs.
// eslint-disable-next-line no-control-regex
const jsonStringPattern = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;
function splitEscapedAltNames(altNames) {
    const result = [];
    let currentToken = '';
    let offset = 0;
    while (offset !== altNames.length) {
        const nextSep = altNames.indexOf(',', offset);
        const nextQuote = altNames.indexOf('"', offset);
        if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
            // There is a quote character and there is no separator before the quote.
            currentToken += altNames.substring(offset, nextQuote);
            const match = jsonStringPattern.exec(altNames.substring(nextQuote));
            if (!match)
                throw tlsCertAltnameFormat();
            currentToken += JSONParse(match[0]);
            offset = nextQuote + match[0].length;
        }
        else if (nextSep !== -1) {
            // There is a separator and no quote before it.
            currentToken += altNames.substring(offset, nextSep);
            result.push(currentToken);
            currentToken = '';
            offset = nextSep + 2;
        }
        else {
            currentToken += altNames.substring(offset);
            offset = altNames.length;
        }
    }
    result.push(currentToken);
    return result;
}
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_DOT = 46;
const CHAR_COLON = 58;
const CHAR_PERCENT = 37;
// UV__INET6_ADDRSTRLEN - 1: the longest address before a zone.
const INET6_ADDRESS_MAX = 45;
/** inet_pton4: four decimal octets, none above 255 or with a leading zero; the bytes, or null. */
function inetPton4(text) {
    const bytes = [0, 0, 0, 0];
    let sawDigit = false;
    let octets = 0;
    let at = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = stringCharCodeAt(text, i);
        if (ch >= CHAR_0 && ch <= CHAR_9) {
            const next = bytes[at] * 10 + (ch - CHAR_0);
            if (sawDigit && bytes[at] === 0)
                return null;
            if (next > 255)
                return null;
            bytes[at] = next;
            if (!sawDigit) {
                if (++octets > 4)
                    return null;
                sawDigit = true;
            }
        }
        else if (ch === CHAR_DOT && sawDigit) {
            if (octets === 4)
                return null;
            at++;
            sawDigit = false;
        }
        else {
            return null;
        }
    }
    return octets < 4 ? null : bytes;
}
/** A hex digit's value, in either case, or -1. */
function hexValue(ch) {
    if (ch >= CHAR_0 && ch <= CHAR_9)
        return ch - CHAR_0;
    if (ch >= 97 && ch <= 102)
        return ch - 87;
    if (ch >= 65 && ch <= 70)
        return ch - 55;
    return -1;
}
/**
 * inet_pton6: groups of one to four hex digits, one "::" for a run of zero
 * groups, and an IPv4 address as the last 32 bits; the bytes, or null.
 */
function inetPton6(text) {
    const bytes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let tp = 0;
    let colon = -1;
    let i = 0;
    // Leading :: requires some special handling.
    if (stringCharCodeAt(text, 0) === CHAR_COLON && stringCharCodeAt(text, ++i) !== CHAR_COLON)
        return null;
    let token = i;
    let digits = 0;
    let value = 0;
    while (i < text.length) {
        const ch = stringCharCodeAt(text, i++);
        const hex = hexValue(ch);
        if (hex !== -1) {
            value = (value << 4) | hex;
            if (++digits > 4)
                return null;
            continue;
        }
        if (ch === CHAR_COLON) {
            token = i;
            if (digits === 0) {
                if (colon !== -1)
                    return null;
                colon = tp;
                continue;
            }
            if (i === text.length || tp + 2 > 16)
                return null;
            bytes[tp++] = (value >> 8) & 0xff;
            bytes[tp++] = value & 0xff;
            digits = 0;
            value = 0;
            continue;
        }
        const ipv4 = ch === CHAR_DOT && tp + 4 <= 16 ? inetPton4(stringSlice(text, token)) : null;
        if (ipv4 === null)
            return null;
        for (let k = 0; k < 4; k++)
            bytes[tp++] = ipv4[k];
        digits = 0;
        break;
    }
    if (digits !== 0) {
        if (tp + 2 > 16)
            return null;
        bytes[tp++] = (value >> 8) & 0xff;
        bytes[tp++] = value & 0xff;
    }
    if (colon !== -1) {
        if (tp === 16)
            return null;
        const n = tp - colon;
        for (let k = 1; k <= n; k++) {
            bytes[16 - k] = bytes[colon + n - k];
            bytes[colon + n - k] = 0;
        }
        tp = 16;
    }
    return tp === 16 ? bytes : null;
}
/** inet_ntop4: the four octets in decimal. */
function inetNtop4(bytes, from) {
    return arrayJoin([`${bytes[from]}`, `${bytes[from + 1]}`, `${bytes[from + 2]}`, `${bytes[from + 3]}`], '.');
}
/**
 * inet_ntop6: lowercase hex groups, the first longest run of two or more
 * zero groups as "::", and an IPv4-mapped or IPv4-compatible address with
 * its last 32 bits dotted.
 */
function inetNtop6(bytes) {
    const words = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 8; k++)
        words[k] = (bytes[2 * k] << 8) | bytes[2 * k + 1];
    let bestBase = -1;
    let bestLen = 0;
    let curBase = -1;
    let curLen = 0;
    for (let k = 0; k < 8; k++) {
        if (words[k] === 0) {
            if (curBase === -1) {
                curBase = k;
                curLen = 1;
            }
            else {
                curLen++;
            }
        }
        else if (curBase !== -1) {
            if (bestBase === -1 || curLen > bestLen) {
                bestBase = curBase;
                bestLen = curLen;
            }
            curBase = -1;
        }
    }
    if (curBase !== -1 && (bestBase === -1 || curLen > bestLen)) {
        bestBase = curBase;
        bestLen = curLen;
    }
    if (bestBase !== -1 && bestLen < 2)
        bestBase = -1;
    let out = '';
    for (let k = 0; k < 8; k++) {
        // Inside the best run of zeros.
        if (bestBase !== -1 && k >= bestBase && k < bestBase + bestLen) {
            if (k === bestBase)
                out += ':';
            continue;
        }
        // Following an initial run of zeros or any real hex.
        if (k !== 0)
            out += ':';
        // An encapsulated IPv4 address.
        if (k === 6 && bestBase === 0 && (bestLen === 6 || (bestLen === 7 && words[7] !== 0x0001) || (bestLen === 5 && words[5] === 0xffff))) {
            out += inetNtop4(bytes, 12);
            break;
        }
        out += reflectApply(NumberPrototypeToString, words[k], [16]);
    }
    // A trailing run of zeros.
    if (bestBase !== -1 && bestBase + bestLen === 8)
        out += ':';
    return out;
}
/**
 * CanonicalizeIP: `ip` as libuv prints the address it parses, IPv4 first,
 * or undefined when it is neither. The binding reads a C string, so a NUL
 * ends it, and uv_inet_pton drops an IPv6 zone ("%eth0") before it parses.
 */
function canonicalizeIP(ip) {
    const nul = stringIndexOf(ip, '\u0000');
    const text = nul === -1 ? ip : stringSlice(ip, 0, nul);
    const ipv4 = inetPton4(text);
    if (ipv4 !== null)
        return inetNtop4(ipv4, 0);
    const zone = stringIndexOf(text, StringFromCharCode(CHAR_PERCENT));
    if (zone > INET6_ADDRESS_MAX)
        return undefined;
    const ipv6 = inetPton6(zone === -1 ? text : stringSlice(text, 0, zone));
    return ipv6 === null ? undefined : inetNtop6(ipv6);
}
/** Node's tls.checkServerIdentity, reading isIP and domainToASCII from `host`. */
export function createCheckServerIdentity(host) {
    return function checkServerIdentity(hostname, cert) {
        const subject = cert.subject;
        const altNames = cert.subjectaltname;
        const dnsNames = [];
        const ips = [];
        hostname = '' + hostname;
        const hostnameASCII = host.domainToASCII(hostname);
        // Remove trailing dots for error messages and matching.
        hostname = unfqdn(hostname);
        const hostnameASCIIWithoutFQDN = unfqdn(hostnameASCII);
        const hostnameIsIP = host.isIP(hostname);
        const hostnameASCIIIsIP = host.isIP(hostnameASCIIWithoutFQDN);
        if (altNames) {
            const splitAltNames = altNames.includes('"') ? splitEscapedAltNames(altNames) : altNames.split(', ');
            splitAltNames.forEach((name) => {
                if (name.startsWith('DNS:')) {
                    dnsNames.push(name.slice(4));
                }
                else if (name.startsWith('IP Address:')) {
                    ips.push(canonicalizeIP(name.slice(11)));
                }
            });
        }
        // Non-canonical IP address spellings can be interpreted differently by
        // domainToASCII() and the operating system resolver: refused.
        if (!hostnameIsIP && hostnameASCIIIsIP) {
            return tlsCertAltnameInvalid('Host is a non-canonical IP address', hostname, cert);
        }
        let valid = false;
        let reason = 'Unknown reason';
        // An IP host is matched as written: domainToASCII() answers '' for an IPv6 literal.
        if (hostnameIsIP) {
            valid = ips.includes(canonicalizeIP(hostname));
            if (!valid)
                reason = `IP: ${hostname} is not in the cert's list: ${ips.join(', ')}`;
        }
        else if (dnsNames.length > 0 || subject?.CN) {
            const hostParts = splitHost(hostnameASCIIWithoutFQDN);
            const wildcard = (pattern) => check(hostParts, pattern, true);
            if (dnsNames.length > 0) {
                valid = dnsNames.some(wildcard);
                if (!valid)
                    reason = `Host: ${hostname}. is not in the cert's altnames: ${altNames}`;
            }
            else {
                // Match against Common Name only if no supported identifiers exist.
                const cn = subject?.CN;
                if (arrayIsArray(cn))
                    valid = cn.some(wildcard);
                else if (cn)
                    valid = wildcard(cn);
                if (!valid)
                    reason = `Host: ${hostname}. is not cert's CN: ${cn}`;
            }
        }
        else {
            reason = 'Cert does not contain a DNS name';
        }
        if (!valid)
            return tlsCertAltnameInvalid(reason, hostname, cert);
        return undefined;
    };
}
