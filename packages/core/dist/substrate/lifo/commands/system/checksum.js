import { createHash } from 'node:crypto';
import { decodeLossless, encodeLossless, inputChunks, readAllInput, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { shellEscape } from '../../../../_shared/shell-quote.js';
function nodeHasher(name) {
    const h = createHash(name);
    return { update: (b) => { h.update(b); }, digest: () => new Uint8Array(h.digest()) };
}
/**
 * BLAKE2b (RFC 7693) with an output of `outBytes` (1..64), in 32-bit
 * arithmetic: each 64-bit word is a (low, high) pair in a Uint32Array, and
 * whole 128-byte blocks are compressed straight from the input.
 */
function blake2b(outBytes) {
    const IV = new Uint32Array([
        0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
        0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
    ]);
    const SIGMA = new Uint8Array([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
        11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
        9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
        12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
        6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
    ]);
    const h = IV.slice();
    h[0] ^= 0x01010000 ^ outBytes;
    const v = new Uint32Array(32);
    const m = new Uint32Array(32);
    let t0 = 0, t1 = 0; // bytes compressed, as a 64-bit pair
    const buf = new Uint8Array(128);
    let fill = 0;
    // v[a] += v[b] (64-bit, pairs at 2a/2b).
    const add = (a, b) => {
        const lo = v[a] + v[b];
        v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
        v[a] = lo;
    };
    const addM = (a, lo, hi) => {
        const sum = v[a] + lo;
        v[a + 1] = v[a + 1] + hi + (sum >= 0x100000000 ? 1 : 0);
        v[a] = sum;
    };
    const G = (a, b, c, d, x, y) => {
        add(a, b);
        addM(a, m[x], m[x + 1]);
        // v[d] = rotr64(v[d] ^ v[a], 32): swap the halves.
        let xl = v[d] ^ v[a], xh = v[d + 1] ^ v[a + 1];
        v[d] = xh;
        v[d + 1] = xl;
        add(c, d);
        // rotr 24
        xl = v[b] ^ v[c];
        xh = v[b + 1] ^ v[c + 1];
        v[b] = (xl >>> 24) ^ (xh << 8);
        v[b + 1] = (xh >>> 24) ^ (xl << 8);
        add(a, b);
        addM(a, m[y], m[y + 1]);
        // rotr 16
        xl = v[d] ^ v[a];
        xh = v[d + 1] ^ v[a + 1];
        v[d] = (xl >>> 16) ^ (xh << 16);
        v[d + 1] = (xh >>> 16) ^ (xl << 16);
        add(c, d);
        // rotr 63 = rotl 1
        xl = v[b] ^ v[c];
        xh = v[b + 1] ^ v[c + 1];
        v[b] = (xh >>> 31) ^ (xl << 1);
        v[b + 1] = (xl >>> 31) ^ (xh << 1);
    };
    const compress = (block, at, last) => {
        for (let i = 0; i < 16; i++)
            v[i] = h[i];
        for (let i = 0; i < 16; i++)
            v[i + 16] = IV[i];
        v[24] ^= t0;
        v[25] ^= t1;
        if (last) {
            v[28] = ~v[28];
            v[29] = ~v[29];
        }
        for (let i = 0; i < 32; i++) {
            const o = at + i * 4;
            m[i] = block[o] ^ (block[o + 1] << 8) ^ (block[o + 2] << 16) ^ (block[o + 3] << 24);
        }
        for (let r = 0; r < 12; r++) {
            const s = (r % 10) * 16;
            G(0, 8, 16, 24, SIGMA[s] * 2, SIGMA[s + 1] * 2);
            G(2, 10, 18, 26, SIGMA[s + 2] * 2, SIGMA[s + 3] * 2);
            G(4, 12, 20, 28, SIGMA[s + 4] * 2, SIGMA[s + 5] * 2);
            G(6, 14, 22, 30, SIGMA[s + 6] * 2, SIGMA[s + 7] * 2);
            G(0, 10, 20, 30, SIGMA[s + 8] * 2, SIGMA[s + 9] * 2);
            G(2, 12, 22, 24, SIGMA[s + 10] * 2, SIGMA[s + 11] * 2);
            G(4, 14, 16, 26, SIGMA[s + 12] * 2, SIGMA[s + 13] * 2);
            G(6, 8, 18, 28, SIGMA[s + 14] * 2, SIGMA[s + 15] * 2);
        }
        for (let i = 0; i < 16; i++)
            h[i] ^= v[i] ^ v[i + 16];
    };
    const count = (n) => {
        t0 += n;
        if (t0 >= 0x100000000) {
            t0 -= 0x100000000;
            t1 = (t1 + 1) >>> 0;
        }
    };
    return {
        update(bytes) {
            let i = 0;
            // The last block is compressed specially, so a full buffer waits for more input.
            if (fill > 0) {
                const take = Math.min(128 - fill, bytes.length);
                buf.set(bytes.subarray(0, take), fill);
                fill += take;
                i = take;
                if (fill === 128 && i < bytes.length) {
                    count(128);
                    compress(buf, 0, false);
                    fill = 0;
                }
            }
            for (; bytes.length - i > 128; i += 128) {
                count(128);
                compress(bytes, i, false);
            }
            if (i < bytes.length) {
                buf.set(bytes.subarray(i), fill);
                fill += bytes.length - i;
            }
        },
        digest() {
            count(fill);
            buf.fill(0, fill);
            compress(buf, 0, true);
            const out = new Uint8Array(64);
            for (let i = 0; i < 16; i++) {
                out[i * 4] = h[i];
                out[i * 4 + 1] = h[i] >>> 8;
                out[i * 4 + 2] = h[i] >>> 16;
                out[i * 4 + 3] = h[i] >>> 24;
            }
            return out.subarray(0, outBytes);
        },
    };
}
const CRC_POSIX = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 24;
        for (let k = 0; k < 8; k++)
            c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
        table[i] = c >>> 0;
    }
    return table;
})();
const CRC_32B = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();
function crcPosix() {
    let crc = 0;
    let size = 0;
    return {
        update(bytes) {
            for (const b of bytes)
                crc = ((crc << 8) ^ CRC_POSIX[((crc >>> 24) ^ b) & 0xff]) >>> 0;
            size += bytes.length;
        },
        result() {
            let c = crc;
            for (let n = size; n > 0; n = Math.floor(n / 256))
                c = ((c << 8) ^ CRC_POSIX[((c >>> 24) ^ (n & 0xff)) & 0xff]) >>> 0;
            return { value: (~c) >>> 0, size };
        },
    };
}
function crc32b() {
    let crc = 0xffffffff;
    let size = 0;
    return {
        update(bytes) {
            for (const b of bytes)
                crc = (crc >>> 8) ^ CRC_32B[(crc ^ b) & 0xff];
            size += bytes.length;
        },
        result: () => ({ value: (crc ^ 0xffffffff) >>> 0, size }),
    };
}
function bsdSum() {
    let sum = 0;
    let size = 0;
    return {
        update(bytes) {
            for (const b of bytes) {
                sum = (sum >> 1) + ((sum & 1) << 15);
                sum = (sum + b) & 0xffff;
            }
            size += bytes.length;
        },
        result: () => ({ value: sum, size }),
    };
}
function sysvSum() {
    let sum = 0;
    let size = 0;
    return {
        update(bytes) {
            for (const b of bytes)
                sum = (sum + b) >>> 0;
            size += bytes.length;
        },
        result() {
            let r = (sum & 0xffff) + (sum >>> 16);
            r = (r & 0xffff) + (r >>> 16);
            return { value: r, size };
        },
    };
}
const DIGESTS = {
    md5: { tag: 'MD5', bits: 128, make: () => nodeHasher('md5') },
    sha1: { tag: 'SHA1', bits: 160, make: () => nodeHasher('sha1') },
    sha224: { tag: 'SHA224', bits: 224, make: () => nodeHasher('sha224') },
    sha256: { tag: 'SHA256', bits: 256, make: () => nodeHasher('sha256') },
    sha384: { tag: 'SHA384', bits: 384, make: () => nodeHasher('sha384') },
    sha512: { tag: 'SHA512', bits: 512, make: () => nodeHasher('sha512') },
    blake2b: { tag: 'BLAKE2b', bits: 512, make: (bits) => blake2b(bits / 8) },
};
function digestAlgorithm(name) {
    const d = DIGESTS[name];
    return { kind: 'digest', name, ...d };
}
// ── output ──
/** A name as GNU prints it: with `\`, newline or CR it is escaped and the line gets a leading `\`. */
function escapeName(name, zero) {
    if (zero || !/[\\\n\r]/.test(name))
        return { name, escaped: false };
    return { name: name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r'), escaped: true };
}
function unescapeName(name) {
    let out = '';
    for (let i = 0; i < name.length; i++) {
        if (name[i] !== '\\') {
            out += name[i];
            continue;
        }
        const n = name[++i];
        if (n === '\\')
            out += '\\';
        else if (n === 'n')
            out += '\n';
        else if (n === 'r')
            out += '\r';
        else
            return null;
    }
    return out;
}
const toBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
async function hashFile(ctx, file, algorithm, bits) {
    if (algorithm.kind === 'digest') {
        const h = algorithm.make(bits);
        for await (const chunk of inputChunks(ctx, file))
            h.update(chunk);
        return h.digest();
    }
    const c = algorithm.kind === 'crc' ? crcPosix() : algorithm.kind === 'crc32b' ? crc32b() : algorithm.kind === 'bsd' ? bsdSum() : sysvSum();
    for await (const chunk of inputChunks(ctx, file))
        c.update(chunk);
    return c.result();
}
function tagOf(algorithm, bits) {
    if (algorithm.kind !== 'digest')
        return '';
    return algorithm.name === 'blake2b' && bits !== 512 ? `BLAKE2b-${bits}` : algorithm.tag;
}
async function sumFiles(ctx, o) {
    let status = 0;
    const files = o.files.length > 0 ? o.files : ['-'];
    const end = o.zero ? '\0' : '\n';
    for (const file of files) {
        let result;
        try {
            result = await hashFile(ctx, file, o.algorithm, o.bits);
        }
        catch (error) {
            await ctx.stderr.write(`${o.program}: ${shellEscape(file)}: ${strerror(error)}\n`);
            status = 1;
            continue;
        }
        if (!(result instanceof Uint8Array)) {
            const { value, size } = result;
            let line;
            if (o.algorithm.kind === 'bsd')
                line = `${String(value).padStart(5, '0')} ${String(Math.ceil(size / 1024)).padStart(5)}`;
            else if (o.algorithm.kind === 'sysv')
                line = `${value} ${Math.ceil(size / 512)}`;
            else
                line = `${value} ${size}`;
            // cksum names every file but standard input; sum names them when there are operands.
            const showName = o.algorithm.kind === 'crc' || o.algorithm.kind === 'crc32b' ? file !== '-' : o.files.length > 0 && (files.length > 1 || file !== '-');
            await writeBytes(ctx.stdout, encodeLossless(`${line}${showName ? ` ${file}` : ''}\n`));
            continue;
        }
        if (o.raw) {
            await writeBytes(ctx.stdout, result);
            continue;
        }
        const value = o.base64 ? toBase64(result) : hex(result);
        const { name, escaped } = escapeName(file, o.zero);
        const line = o.tag
            ? `${escaped ? '\\' : ''}${tagOf(o.algorithm, o.bits)} (${name}) = ${value}${end}`
            : `${escaped ? '\\' : ''}${value} ${o.binary ? '*' : ' '}${name}${end}`;
        await writeBytes(ctx.stdout, encodeLossless(line));
    }
    return status;
}
// ── -c ──
/** A tag as a line writes it: MD5, SHA1, ..., BLAKE2b or BLAKE2b-N. */
function tagged(tag) {
    for (const [name, d] of Object.entries(DIGESTS)) {
        if (tag === d.tag)
            return { algorithm: digestAlgorithm(name), bits: d.bits };
    }
    const m = /^BLAKE2b-(\d+)$/.exec(tag);
    if (m) {
        const bits = Number(m[1]);
        if (bits > 0 && bits <= 512 && bits % 8 === 0)
            return { algorithm: digestAlgorithm('blake2b'), bits };
    }
    return null;
}
/** A digest as a line writes it, in hex or (cksum only) base64, if it has `bits`. */
function digestText(text, bits, base64) {
    if (/^[0-9A-Fa-f]+$/.test(text) && text.length * 4 === bits)
        return true;
    return base64 && /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length === Math.ceil(bits / 8 / 3) * 4;
}
async function checkFiles(ctx, o) {
    const lists = o.files.length > 0 ? o.files : ['-'];
    let status = 0;
    const say = async (text) => { if (o.mode !== 'status')
        await ctx.stdout.write(text); };
    const warn = async (text) => { if (o.mode !== 'status')
        await ctx.stderr.write(`${o.program}: ${text}\n`); };
    const base64 = o.program === 'cksum';
    for (const list of lists) {
        let text;
        try {
            text = decodeLossless(await readAllInput(ctx, list));
        }
        catch (error) {
            await ctx.stderr.write(`${o.program}: ${shellEscape(list)}: ${strerror(error)}\n`);
            status = 1;
            continue;
        }
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        let formatted = 0, badFormat = 0, mismatched = 0, unreadable = 0, matched = 0;
        for (const [index, raw] of lines.entries()) {
            let line = raw.replace(/\r$/, '');
            let escaped = false;
            if (line.startsWith('\\')) {
                escaped = true;
                line = line.slice(1);
            }
            let want = null;
            let name = null;
            let algorithm = o.algorithm;
            let bits = o.bits;
            const t = /^(\w+(?:-\d+)?) \((.*)\) = (\S+)$/.exec(line);
            if (t) {
                const found = tagged(t[1]);
                // cksum without -a takes each line's algorithm; otherwise the line must be ours.
                const ours = found !== null && (o.anyTagged || (found.algorithm.kind === 'digest' && o.algorithm.kind === 'digest'
                    && found.algorithm.name === o.algorithm.name && (found.algorithm.name !== 'blake2b' || o.bits === 512 || found.bits === o.bits)));
                if (found && ours && digestText(t[3], found.bits, base64)) {
                    algorithm = found.algorithm;
                    bits = found.bits;
                    want = t[3];
                    name = t[2];
                }
            }
            else if (!o.anyTagged) {
                // HEX, a space, then an optional type mark (' ' text, '*' binary), then the name.
                const plain = /^(\S+) ([ *]?)(.*)$/.exec(line);
                // BLAKE2b takes an untagged digest's length from its digits.
                if (plain && o.blake2bAnyLength && /^[0-9A-Fa-f]+$/.test(plain[1]) && plain[1].length % 2 === 0 && plain[1].length <= 128)
                    bits = plain[1].length * 4;
                if (plain && digestText(plain[1], bits, base64)) {
                    want = plain[1];
                    name = plain[3];
                }
            }
            if (want !== null && name !== null && escaped)
                name = unescapeName(name);
            if (want === null || name === null || name === '') {
                badFormat++;
                if (o.mode === 'warn')
                    await warn(`${shellEscape(list)}: ${index + 1}: improperly formatted ${tagOf(o.algorithm, o.bits) || 'checksum'} checksum line`);
                continue;
            }
            formatted++;
            let got;
            try {
                got = await hashFile(ctx, name, algorithm, bits);
            }
            catch (error) {
                const code = error.code;
                if (o.ignoreMissing && code === 'ENOENT')
                    continue;
                unreadable++;
                await ctx.stderr.write(`${o.program}: ${shellEscape(name)}: ${strerror(error)}\n`);
                await say(`${name}: FAILED open or read\n`);
                continue;
            }
            const value = /^[0-9A-Fa-f]+$/.test(want) && want.length === got.length * 2 ? hex(got) : toBase64(got);
            const same = value === (value === hex(got) ? want.toLowerCase() : want);
            // The name is reported as the line wrote it, escapes and all.
            const shown = escapeName(name, false);
            const label = `${shown.escaped ? '\\' : ''}${shown.name}`;
            if (same) {
                matched++;
                if (o.mode !== 'quiet')
                    await say(`${label}: OK\n`);
            }
            else {
                mismatched++;
                await say(`${label}: FAILED\n`);
            }
        }
        if (formatted === 0) {
            await ctx.stderr.write(`${o.program}: ${list === '-' ? 'standard input' : shellEscape(list)}: no properly formatted checksum lines found\n`);
            status = 1;
            continue;
        }
        const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        if (badFormat > 0)
            await warn(`WARNING: ${plural(badFormat, 'line is', 'lines are')} improperly formatted`);
        if (unreadable > 0)
            await warn(`WARNING: ${plural(unreadable, 'listed file could not be read', 'listed files could not be read')}`);
        if (mismatched > 0)
            await warn(`WARNING: ${plural(mismatched, 'computed checksum did NOT match', 'computed checksums did NOT match')}`);
        if (o.ignoreMissing && matched === 0 && mismatched === 0 && unreadable === 0) {
            await warn(`${shellEscape(list)}: no file was verified`);
            status = 1;
        }
        if (mismatched > 0 || unreadable > 0 || (o.strict && badFormat > 0))
            status = 1;
    }
    return status;
}
// ── commands ──
function makeCommand(program, fixed) {
    return async (ctx) => {
        const usage = async (message) => {
            await ctx.stderr.write(`${program}: ${message}\nTry '${program} --help' for more information.\n`);
            return 1;
        };
        const o = {
            program, algorithm: fixed ?? { kind: 'crc' }, anyTagged: false, blake2bAnyLength: false, bits: 0, binary: false, tag: false, zero: false,
            base64: false, raw: false, check: false, ignoreMissing: false, mode: 'normal', strict: false, files: [],
        };
        let length = null;
        let untagged = false;
        let algorithmGiven = false;
        let binaryOrText = false;
        let tagGiven = false;
        // The -c-only options, in the order given (GNU names the first it checks).
        const checkOnly = new Set();
        const sumMode = program === 'sum';
        const setAlgorithm = (a) => {
            algorithmGiven = true;
            if (a in DIGESTS)
                o.algorithm = digestAlgorithm(a);
            else if (a === 'crc' || a === 'crc32b' || a === 'bsd' || a === 'sysv')
                o.algorithm = { kind: a };
            else
                return `invalid argument \u2018${a}\u2019 for \u2018--algorithm\u2019`;
            return null;
        };
        const args = ctx.args;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === '--') {
                o.files.push(...args.slice(i + 1));
                break;
            }
            if (arg.startsWith('--')) {
                const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
                const value = () => inline ?? args[++i];
                switch (name) {
                    case 'binary':
                        o.binary = true;
                        binaryOrText = true;
                        break;
                    case 'text':
                        o.binary = false;
                        binaryOrText = true;
                        break;
                    case 'tag':
                        o.tag = true;
                        tagGiven = true;
                        break;
                    case 'untagged':
                        untagged = true;
                        break;
                    case 'zero':
                        o.zero = true;
                        break;
                    case 'check':
                        o.check = true;
                        break;
                    case 'ignore-missing':
                        o.ignoreMissing = true;
                        checkOnly.add('ignore-missing');
                        break;
                    case 'quiet':
                        o.mode = 'quiet';
                        checkOnly.add('quiet');
                        break;
                    case 'status':
                        o.mode = 'status';
                        checkOnly.add('status');
                        break;
                    case 'strict':
                        o.strict = true;
                        checkOnly.add('strict');
                        break;
                    case 'warn':
                        o.mode = 'warn';
                        checkOnly.add('warn');
                        break;
                    case 'base64':
                        o.base64 = true;
                        break;
                    case 'raw':
                        o.raw = true;
                        break;
                    case 'debug': break;
                    case 'length':
                        length = Number(value());
                        break;
                    case 'algorithm': {
                        if (fixed !== null)
                            return usage(`unrecognized option '--algorithm'`);
                        const error = setAlgorithm(value());
                        if (error)
                            return usage(error);
                        break;
                    }
                    case 'sysv': if (sumMode) {
                        o.algorithm = { kind: 'sysv' };
                        break;
                    }
                    // falls through
                    default: return usage(`unrecognized option '--${name}'`);
                }
                continue;
            }
            if (!arg.startsWith('-') || arg === '-') {
                o.files.push(arg);
                continue;
            }
            for (let j = 1; j < arg.length; j++) {
                const flag = arg[j];
                if ((flag === 'l' && program !== 'sum') || (flag === 'a' && fixed === null)) {
                    let value = arg.slice(j + 1);
                    if (value === '')
                        value = args[++i];
                    if (value === undefined)
                        return usage(`option requires an argument -- '${flag}'`);
                    if (flag === 'l')
                        length = Number(value);
                    else {
                        const error = setAlgorithm(value);
                        if (error)
                            return usage(error);
                    }
                    break;
                }
                if (sumMode && flag === 'r') {
                    o.algorithm = { kind: 'bsd' };
                    continue;
                }
                if (sumMode && flag === 's') {
                    o.algorithm = { kind: 'sysv' };
                    continue;
                }
                if (sumMode)
                    return usage(`invalid option -- '${flag}'`);
                if (flag === 'b') {
                    o.binary = true;
                    binaryOrText = true;
                }
                else if (flag === 't') {
                    o.binary = false;
                    binaryOrText = true;
                }
                else if (flag === 'c')
                    o.check = true;
                else if (flag === 'w') {
                    o.mode = 'warn';
                    checkOnly.add('warn');
                }
                else if (flag === 'z')
                    o.zero = true;
                else
                    return usage(`invalid option -- '${flag}'`);
            }
        }
        // Everything a combination of options refuses, before any work (GNU's order).
        if (length !== null && (o.algorithm.kind !== 'digest' || o.algorithm.name !== 'blake2b')) {
            await ctx.stderr.write(`${program}: --length is only supported with --algorithm=blake2b\n`);
            return 1;
        }
        if (o.check && o.algorithm.kind !== 'digest' && fixed === null && algorithmGiven) {
            await ctx.stderr.write(`${program}: --check is not supported with --algorithm={bsd,sysv,crc,crc32b}\n`);
            return 1;
        }
        if (o.check && (binaryOrText || (tagGiven && program === 'cksum')))
            return usage('the --binary and --text options are meaningless when verifying checksums');
        if (o.check && tagGiven)
            return usage('the --tag option is meaningless when verifying checksums');
        if (o.check && o.zero)
            return usage('the --zero option is not supported when verifying checksums');
        if (!o.check) {
            for (const option of ['ignore-missing', 'status', 'warn', 'quiet', 'strict']) {
                if (checkOnly.has(option))
                    return usage(`the --${option} option is meaningful only when verifying checksums`);
            }
        }
        if (o.algorithm.kind === 'digest') {
            o.bits = o.algorithm.bits;
            if (length !== null) {
                // Over the maximum is the maximum (GNU); 0 is the default.
                if (!Number.isInteger(length) || length % 8 !== 0 || length < 0) {
                    await ctx.stderr.write(`${program}: invalid length: \u2018${length}\u2019\n${program}: length is not a multiple of 8\n`);
                    return 1;
                }
                if (length > 0)
                    o.bits = Math.min(length, 512);
            }
            // cksum tags its digests unless told not to; the *sum tools tag with --tag.
            if (fixed === null)
                o.tag = !untagged;
        }
        // An untagged BLAKE2b line's length is its digest's, -l or not (GNU).
        o.blake2bAnyLength = o.algorithm.kind === 'digest' && o.algorithm.name === 'blake2b';
        // cksum -c with no -a: each tagged line names its own algorithm.
        if (fixed === null && o.check && !algorithmGiven)
            o.anyTagged = true;
        return o.check ? checkFiles(ctx, o) : sumFiles(ctx, o);
    };
}
export const md5sum = makeCommand('md5sum', digestAlgorithm('md5'));
export const sha1sum = makeCommand('sha1sum', digestAlgorithm('sha1'));
export const sha224sum = makeCommand('sha224sum', digestAlgorithm('sha224'));
export const sha256sum = makeCommand('sha256sum', digestAlgorithm('sha256'));
export const sha384sum = makeCommand('sha384sum', digestAlgorithm('sha384'));
export const sha512sum = makeCommand('sha512sum', digestAlgorithm('sha512'));
export const b2sum = makeCommand('b2sum', digestAlgorithm('blake2b'));
export const cksum = makeCommand('cksum', null);
export const sum = makeCommand('sum', { kind: 'bsd' });
