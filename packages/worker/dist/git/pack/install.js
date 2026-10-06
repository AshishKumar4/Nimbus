/**
 * git/pack/install.ts — a pack as the session stores it: written by ranged
 * appends as it arrives, read back by range, and installed once decoded.
 * One implementation for every pack the git facet takes: a clone's, a
 * history piece's, a fetch's, a promisor fetch's.
 *
 * Installing follows git (index-pack's finish_tmp_packfile): the idx and
 * the reverse index (.rev) are written under temporary names, the .promisor
 * beside them, then the pack is named, the .rev, and the idx last, so no
 * reader finds an idx whose pack is not all there. A step that may be run again after its answer was lost (a resumed
 * pack, which cannot be fetched again) asks for a durable record of the
 * outcome, written before anything is named: run again, it finds the
 * record, finishes the naming, and returns it (resumeInstall).
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
    if ((await files.readdir(dir)).includes('pack-' + packSha + '.idx')) {
        await files.remove(tmp);
        if (request.record !== undefined)
            await writeWhole(files, request.record.path, encoder.encode(JSON.stringify({ summary, extra: request.record.extra })));
        return summary;
    }
    const idx = new RangedPackFile(files, tmpFile(dir, tmpName, 'idx'));
    const entries = result.entries;
    for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield entries; }))
        await idx.append(piece);
    const rev = new RangedPackFile(files, tmpFile(dir, tmpName, 'rev'));
    await rev.append(encodeRev(entries, result.packSha));
    if (request.promisor !== undefined)
        await writeWhole(files, final + '.promisor', encoder.encode(request.promisor));
    if (request.record !== undefined) {
        await writeWhole(files, request.record.path, encoder.encode(JSON.stringify({ summary, extra: request.record.extra })));
    }
    await files.rename(tmp, final + '.pack');
    await files.rename(rev.path, final + '.rev');
    await files.rename(idx.path, final + '.idx');
    return summary;
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
async function writeWhole(files, path, bytes) {
    const file = new RangedPackFile(files, path);
    await files.fsTruncate(path, 0).catch(() => undefined);
    await file.append(bytes);
}
