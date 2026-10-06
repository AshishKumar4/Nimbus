/**
 * git/pack/install.ts — a pack as the session stores it: written by ranged
 * appends as it arrives, read back by range, and installed once decoded.
 * One implementation for every pack the git facet takes: a clone's, a
 * history piece's, a fetch's, a promisor fetch's.
 *
 * Installing follows git's order (index-pack's finish_tmp_packfile): the
 * pack is named first and its idx last, so no reader finds an idx whose
 * pack is not all there. Every session call waits its turn behind the
 * clone's write waves (measured live: vscode's history ~25% slower with
 * eight more calls a pack), so an ordinary pack costs one rename and one
 * write of its .promisor, .rev and idx together, the idx last. A step that
 * may be run again after its answer was lost (a resumed pack, which cannot
 * be fetched again) asks for a durable record of the outcome: then the idx
 * and .rev go under temporary names with the record before anything is
 * named, and are renamed after the pack; run again, the step finds the
 * record and finishes the naming (resumeInstall).
 */
import { encodeIdxV2, encodeRev } from './idx.js';
import { oidToHex, PackFormatError } from './format.js';
/** Pieces of a ranged write: the session appends a piece in place below 512 KiB. */
const WRITE_PIECE_BYTES = 448 * 1024;
/** Pieces of a ranged read: well inside what one RPC may carry. */
const READ_PIECE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Bytes [offset, offset + length) of `path`, read in pieces; short or missing is an error. */
export async function readRange(files, path, offset, length) {
    const out = new Uint8Array(length);
    for (let at = 0; at < length; at += READ_PIECE_BYTES) {
        const want = Math.min(READ_PIECE_BYTES, length - at);
        const piece = await files.fsReadRange(path, offset + at, want);
        if (piece === null || piece.byteLength !== want) {
            throw new PackFormatError(path + ': range ' + (offset + at) + '+' + want + ' came back ' + (piece === null ? 'missing' : piece.byteLength + ' bytes'));
        }
        out.set(piece, at);
    }
    return out;
}
/** A file written by ranged appends and read back by range: a pack as it arrives, or an idx. */
export class RangedPackFile {
    files;
    path;
    size = 0;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async append(bytes) {
        for (let at = 0; at < bytes.byteLength; at += WRITE_PIECE_BYTES) {
            const piece = bytes.byteLength <= WRITE_PIECE_BYTES ? bytes : bytes.subarray(at, at + WRITE_PIECE_BYTES);
            const offset = this.size;
            this.size += piece.byteLength;
            await this.files.fsWriteRange(this.path, offset, piece);
        }
    }
    async writeAt(offset, bytes) {
        await this.files.fsWriteRange(this.path, offset, bytes);
    }
    async truncate(size) {
        this.size = size;
        await this.files.fsTruncate(this.path, size);
    }
    async read(offset, length) {
        return await readRange(this.files, this.path, offset, length);
    }
}
/** The temporary name of a pack's `kind` file (idx, rev) beside its tmp_pack_ name. */
function tmpFile(dir, tmpName, kind) {
    return dir + '/tmp_' + kind + '_' + tmpName.replace(/^tmp_pack_/, '');
}
/**
 * Name a decoded pack, git's way; the same pack again (git keeps the one it
 * has) and an empty one leave nothing. Null for an empty pack.
 */
export async function installPack(files, request) {
    const { dir, tmpName, result } = request;
    const tmp = dir + '/' + tmpName;
    if (result.entries === null)
        throw new PackFormatError('pack ' + tmpName + ' was not fully decoded');
    if (result.objects === 0) {
        await files.remove(tmp);
        return null;
    }
    const packSha = oidToHex(result.packSha);
    const final = dir + '/pack-' + packSha;
    const summary = { packSha, packBytes: result.packBytes, objects: result.objects, work: result.work };
    const record = request.record === undefined
        ? []
        : [{ path: request.record.path, bytes: encoder.encode(JSON.stringify({ summary, extra: request.record.extra })) }];
    if ((await files.readdir(dir)).includes('pack-' + packSha + '.idx')) {
        await files.remove(tmp);
        if (record.length > 0)
            await files.writeFiles(record, true);
        return summary;
    }
    const entries = result.entries;
    const pieces = [];
    for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield entries; }))
        pieces.push(piece);
    const idx = concat(pieces);
    const rev = encodeRev(entries, result.packSha);
    const promisor = request.promisor === undefined ? [] : [{ path: final + '.promisor', bytes: encoder.encode(request.promisor) }];
    if (record.length === 0) {
        await files.rename(tmp, final + '.pack');
        await files.writeFiles([...promisor, { path: final + '.rev', bytes: rev }, { path: final + '.idx', bytes: idx }], false);
        return summary;
    }
    // A step that may run again: everything it needs to finish the naming is durable first.
    await files.writeFiles([
        ...promisor,
        { path: tmpFile(dir, tmpName, 'rev'), bytes: rev },
        { path: tmpFile(dir, tmpName, 'idx'), bytes: idx },
        ...record,
    ], true);
    await files.rename(tmp, final + '.pack');
    await files.rename(tmpFile(dir, tmpName, 'rev'), final + '.rev');
    await files.rename(tmpFile(dir, tmpName, 'idx'), final + '.idx');
    return summary;
}
function concat(parts) {
    let size = 0;
    for (const part of parts)
        size += part.byteLength;
    const out = new Uint8Array(size);
    size = 0;
    for (const part of parts) {
        out.set(part, size);
        size += part.byteLength;
    }
    return out;
}
/**
 * A step run again whose pack was installed, or was being named, when its
 * answer was lost: the outcome recorded at `recordPath`, with the naming
 * finished. Null when there is no record: the step had not reached it.
 */
export async function resumeInstall(files, dir, tmpName, recordPath) {
    const slash = recordPath.lastIndexOf('/');
    if (!(await files.readdir(recordPath.slice(0, slash))).includes(recordPath.slice(slash + 1)))
        return null;
    const bytes = await files.fsReadRange(recordPath, 0, 1 << 20);
    if (bytes === null)
        return null;
    const record = JSON.parse(decoder.decode(bytes));
    const final = dir + '/pack-' + record.summary.packSha;
    const names = new Set(await files.readdir(dir));
    if (names.has(tmpName)) {
        if (names.has('pack-' + record.summary.packSha + '.pack'))
            await files.remove(dir + '/' + tmpName);
        else
            await files.rename(dir + '/' + tmpName, final + '.pack');
    }
    for (const kind of ['rev', 'idx']) {
        const path = tmpFile(dir, tmpName, kind);
        if (names.has(path.slice(dir.length + 1)))
            await files.rename(path, final + '.' + kind);
    }
    return record;
}
