/**
 * Byte input and output for the text commands. GNU's tools read and write
 * bytes: a byte that is not valid UTF-8 passes through unchanged. Decoding
 * with TextDecoder would turn it into U+FFFD, three different bytes.
 */
import { concatBytes as concatParts, enc, nameDec } from '../../../_shared/bytes.js';
import { readToEnd } from '../../../runtime/process-files.js';
import { isVfsError, syscallError } from '../../../vfs/vfs-error.js';
import { resolve } from './path.js';
import { direntTypeOfStat } from '../../../vfs/dirent-type.js';
import { fitsWholeRead } from '../../../runtime/sqlite-runtime-fs-bridge.js';
const CHUNK = 65536;
/** An operand's bytes in bounded chunks; `-` or undefined is standard input. */
export async function* inputChunks(ctx, operand, { readSize = CHUNK, fileReadSize = CHUNK, slice = false } = {}) {
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
            for (let chunk = await stdin.readBytes(readSize); chunk !== null && chunk.length > 0; chunk = await stdin.readBytes(readSize))
                yield chunk;
            return;
        }
        for (let text = await stdin.read(); text !== null; text = await stdin.read())
            yield encodeLossless(text);
        return;
    }
    const path = resolve(ctx.cwd, operand);
    // A file one read holds is read whole, in one call, as the one file the
    // name leads to; a larger one, or a device, through one description from
    // its first byte to a read that answers none (its end), closed however the
    // reader stops: either way the bytes are one file's, whatever the name
    // names after.
    const whole = await wholeRead(ctx, path, fileReadSize);
    if (whole !== null) {
        if (whole.length > 0)
            yield whole;
        return;
    }
    yield* descriptionChunks(ctx, path, fileReadSize, slice);
}
/** The file at `path` through one description from its first byte to its end, closed however the reader stops. */
async function* descriptionChunks(ctx, path, fileReadSize, slice) {
    const file = await ctx.vfs.open(path, { read: true });
    try {
        if (file.stat.type === 'directory')
            throw syscallError('EISDIR', 'read', path);
        if (direntTypeOfStat(file.stat) === 'character' && !slice) {
            // A reader that wants the operand to its end asks the device for all of
            // it, which the device answers: /dev/null is empty, and an endless
            // device (/dev/zero) refuses.
            const bytes = await ctx.vfs.readFile(path);
            if (bytes.length > 0)
                yield bytes;
            return;
        }
        yield* readToEnd(file, fileReadSize);
    }
    finally {
        await file.close();
    }
}
/** All of an operand's bytes. */
export async function readAllInput(ctx, operand) {
    const parts = [];
    for await (const chunk of inputChunks(ctx, operand))
        parts.push(chunk);
    return concatBytes(parts);
}
/** The parts as one: a single part is itself, uncopied; more are the shared concatenation (_shared/bytes.ts). */
export function concatBytes(parts) {
    return parts.length === 1 ? parts[0] : concatParts(parts);
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
 * Write lossless text (decodeLossless's): as text, unless it carries a byte
 * (U+DC80..U+DCFF) a sink's UTF-8 would not keep, when it goes as its bytes.
 * Not async: plain text is the sink's own write, with no extra await.
 */
export function writeLossless(out, text) {
    return firstLosslessByte(text) === -1 ? out.write(text) : writeBytes(out, encodeLossless(text));
}
/**
 * {@link decodeLossless} across writes: a sequence a write leaves unfinished
 * is held for the next, so a character split between writes decodes whole;
 * what is held at the end decodes byte by byte, as decodeLossless has it.
 */
export class LosslessDecoder {
    held = NOTHING_HELD;
    decode(bytes) {
        const all = this.held.length === 0 ? bytes : concatBytes([this.held, bytes]);
        const cut = unfinishedTail(all);
        this.held = cut === all.length ? NOTHING_HELD : all.slice(cut);
        return decodeLossless(cut === all.length ? all : all.subarray(0, cut));
    }
    end() {
        const rest = this.held;
        this.held = NOTHING_HELD;
        return rest.length === 0 ? '' : decodeLossless(rest);
    }
}
const NOTHING_HELD = new Uint8Array(0);
/** Where a UTF-8 sequence that `bytes` ends inside begins: their length when none does. */
function unfinishedTail(bytes) {
    for (let back = 1; back <= 3 && back <= bytes.length; back++) {
        const at = bytes.length - back;
        const b = bytes[at];
        if (b >= 0x80 && b < 0xc0)
            continue;
        const length = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xc2 && b < 0xe0 ? 2 : 1;
        return length > back ? at : bytes.length;
    }
    return bytes.length;
}
/**
 * An output the shell captures as text (exec's stdout and stderr, `$( )`):
 * the bytes of every command writing to it decoded as one stream, as its
 * reader would read them, and `end`ed when the capture is read.
 */
export function textCapture(append) {
    const decoder = new LosslessDecoder();
    return {
        stream: {
            writeBytes: (bytes) => { append(decoder.decode(bytes)); },
            // Text after bytes that left a character unfinished: those bytes decode alone first. No text is no write.
            write: (text) => { if (text !== '')
                append(decoder.end() + text); },
        },
        end: () => { append(decoder.end()); },
    };
}
/**
 * Bytes as a string without loss: valid UTF-8 decodes to its characters,
 * and every byte of an invalid sequence to U+DC80 + byte (a lone surrogate,
 * which valid UTF-8 never produces). `encodeLossless` inverts it exactly.
 */
export function decodeLossless(bytes) {
    // Valid UTF-8, nearly all of it, decodes natively; only bytes that are not take the walk below.
    try {
        return validUtf8.decode(bytes);
    }
    catch (error) {
        if (!(error instanceof TypeError))
            throw error;
    }
    let out = '';
    let run = 0;
    const flush = (end) => {
        if (end > run)
            out += nameDec.decode(bytes.subarray(run, end));
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
/** Valid UTF-8, decoded as the walk's runs are: a leading U+FEFF kept, as every other character (_shared/bytes.ts nameDec). */
const validUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
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
/** Where the first byte decodeLossless kept as U+DC80 + byte is in `text`, or -1. */
function firstLosslessByte(text) {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xdc80 && c <= 0xdcff && !(i > 0 && isHigh(text.charCodeAt(i - 1))))
            return i;
    }
    return -1;
}
/** The inverse of `decodeLossless`. */
export function encodeLossless(text) {
    const first = firstLosslessByte(text);
    if (first === -1)
        return enc.encode(text);
    const parts = [];
    let run = 0;
    for (let i = first; i < text.length; i++) {
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
/** The errors of a write the store or a device refused: out of room, too large, or lost. */
const REFUSED_WRITE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EFBIG', 'EIO']);
/** Whether `error` is a write the store or a device refused (not a broken pipe: that is SIGPIPE's). */
export function isRefusedWrite(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' && REFUSED_WRITE_CODES.has(error.code);
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
/** A blank, as GNU's field splitting (sort -k, uniq -f) means one: space or tab. */
export function isBlank(byte) {
    return byte === 0x20 || byte === 0x09;
}
/** Where the field starting at `at` in `line` ends: past its leading blanks, then past its non-blanks. */
export function skipBlankField(line, at) {
    while (at < line.length && isBlank(line[at]))
        at++;
    while (at < line.length && !isBlank(line[at]))
        at++;
    return at;
}
/** An ASCII byte in upper case; any other byte as it is (GNU's -f and -i fold no other). */
export function asciiUpper(byte) {
    return byte >= 0x61 && byte <= 0x7a ? byte - 32 : byte;
}
export function asciiBytes(text) {
    return enc.encode(text);
}
/**
 * The file at `path` read whole when one read holds it (fitsWholeRead); null
 * when it is larger, or a device. The stat only chooses whether to try: a
 * refusal that throws costs a deep stack's capture, as a stat does not, and
 * a file that grew past the stat is refused by the read itself (EFBIG).
 */
async function wholeRead(ctx, path, fileReadSize) {
    const seen = await ctx.vfs.stat(path);
    if (seen !== null && !fitsWholeRead(seen, fileReadSize))
        return null;
    try {
        return await ctx.vfs.readFile(path, { maxBytes: fileReadSize });
    }
    catch (error) {
        if (!isVfsError(error) || error.code !== 'EFBIG')
            throw error;
        return null;
    }
}
