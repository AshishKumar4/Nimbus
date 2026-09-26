import { resolve } from './path.js';
const enc = new TextEncoder();
const CHUNK = 65536;
/** An operand's bytes in bounded chunks; `-` or undefined is standard input. */
export async function* inputChunks(ctx, operand) {
    if (operand === undefined || operand === '-') {
        const stdin = ctx.stdin;
        if (stdin === undefined)
            return;
        if (typeof stdin === 'string') {
            const bytes = encodeLossless(stdin);
            for (let i = 0; i < bytes.length; i += CHUNK)
                yield bytes.subarray(i, i + CHUNK);
            return;
        }
        if (stdin.readBytes) {
            for (let chunk = await stdin.readBytes(CHUNK); chunk !== null && chunk.length > 0; chunk = await stdin.readBytes(CHUNK))
                yield chunk;
            return;
        }
        for (let text = await stdin.read(); text !== null; text = await stdin.read())
            yield encodeLossless(text);
        return;
    }
    const path = resolve(ctx.cwd, operand);
    const stat = await ctx.vfs.stat(path);
    if (stat === null)
        throw Object.assign(new Error(`${operand}: No such file or directory`), { code: 'ENOENT' });
    if (stat.type === 'directory')
        throw Object.assign(new Error(`${operand}: Is a directory`), { code: 'EISDIR' });
    const characterDevice = ((stat.mode ?? 0) & 0o170000) === 0o020000;
    if (stat.size === 0 && !characterDevice) {
        // Empty, or a file whose size says nothing (a synthesized /proc entry): read whole.
        const bytes = await ctx.vfs.readFile(path);
        if (bytes.length > 0)
            yield bytes;
        return;
    }
    // A regular file to its end; a character device (/dev/zero) for as long
    // as its reader keeps asking, which is why this is a generator.
    for (let offset = 0;;) {
        const chunk = await ctx.vfs.readRange(path, offset, CHUNK);
        if (chunk.length === 0)
            return;
        yield chunk;
        offset += chunk.length;
    }
}
/** All of an operand's bytes. */
export async function readAllInput(ctx, operand) {
    const parts = [];
    for await (const chunk of inputChunks(ctx, operand))
        parts.push(chunk);
    return concatBytes(parts);
}
export function concatBytes(parts) {
    if (parts.length === 1)
        return parts[0];
    const total = parts.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
/** Write bytes as they are, to a sink that takes bytes; a text-only sink gets their lossless decoding. */
export async function writeBytes(out, bytes) {
    if (bytes.length === 0)
        return;
    if (out.writeBytes)
        await out.writeBytes(bytes);
    else
        await out.write(decodeLossless(bytes));
}
/**
 * Bytes as a string without loss: valid UTF-8 decodes to its characters,
 * and every byte of an invalid sequence to U+DC80 + byte (a lone surrogate,
 * which valid UTF-8 never produces). `encodeLossless` inverts it exactly.
 */
export function decodeLossless(bytes) {
    let out = '';
    let run = 0;
    const flush = (end) => {
        if (end > run)
            out += new TextDecoder().decode(bytes.subarray(run, end));
    };
    for (let i = 0; i < bytes.length;) {
        const b = bytes[i];
        if (b < 0x80) {
            i++;
            continue;
        }
        const len = utf8SequenceLength(bytes, i);
        if (len > 0) {
            i += len;
            continue;
        }
        flush(i);
        out += String.fromCharCode(0xdc00 + b);
        i++;
        run = i;
    }
    flush(bytes.length);
    return out;
}
/** The length of the valid UTF-8 sequence at `i`, or 0. */
export function utf8SequenceLength(bytes, i) {
    const b = bytes[i];
    if (b < 0x80)
        return 1;
    const cont = (k) => i + k < bytes.length && (bytes[i + k] & 0xc0) === 0x80;
    if (b >= 0xc2 && b <= 0xdf)
        return cont(1) ? 2 : 0;
    if (b >= 0xe0 && b <= 0xef) {
        if (!cont(1) || !cont(2))
            return 0;
        const b1 = bytes[i + 1];
        if (b === 0xe0 && b1 < 0xa0)
            return 0;
        if (b === 0xed && b1 >= 0xa0)
            return 0;
        return 3;
    }
    if (b >= 0xf0 && b <= 0xf4) {
        if (!cont(1) || !cont(2) || !cont(3))
            return 0;
        const b1 = bytes[i + 1];
        if (b === 0xf0 && b1 < 0x90)
            return 0;
        if (b === 0xf4 && b1 >= 0x90)
            return 0;
        return 4;
    }
    return 0;
}
/** The inverse of `decodeLossless`. */
export function encodeLossless(text) {
    let has = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xdc80 && c <= 0xdcff && !(i > 0 && isHigh(text.charCodeAt(i - 1)))) {
            has = true;
            break;
        }
    }
    if (!has)
        return enc.encode(text);
    const parts = [];
    let run = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xdc80 && c <= 0xdcff && !(i > 0 && isHigh(text.charCodeAt(i - 1)))) {
            if (i > run)
                parts.push(enc.encode(text.slice(run, i)));
            parts.push(Uint8Array.of(c - 0xdc00));
            run = i + 1;
        }
    }
    if (run < text.length)
        parts.push(enc.encode(text.slice(run)));
    return concatBytes(parts);
}
function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
/** A write to a pipe whose reader has gone: the writer ends there, silently, as SIGPIPE ends it. */
export function isBrokenPipe(error) {
    return error?.code === 'EPIPE';
}
/** GNU's text for a filesystem error. */
export function fsErrorText(error) {
    const code = error?.code;
    if (code === 'ENOENT')
        return 'No such file or directory';
    if (code === 'EACCES' || code === 'EPERM')
        return 'Permission denied';
    if (code === 'EISDIR')
        return 'Is a directory';
    if (code === 'ENOTDIR')
        return 'Not a directory';
    return error instanceof Error ? error.message : String(error);
}
/** Records split on `delim`: each without its delimiter; `terminated` says whether the last had one. */
export function splitRecords(bytes, delim) {
    const records = [];
    let start = 0;
    for (let i = bytes.indexOf(delim); i !== -1; i = bytes.indexOf(delim, start)) {
        records.push(bytes.subarray(start, i));
        start = i + 1;
    }
    const terminated = start === bytes.length;
    if (!terminated)
        records.push(bytes.subarray(start));
    return { records, terminated };
}
export function asciiBytes(text) {
    return enc.encode(text);
}
