/**
 * git/pack/facet-packs.ts — cf-git's `packs` seam inside the git network
 * facet, over the supervisor's ranged reads and writes.
 *
 * read/has/expand serve objects from the session's packs by range
 * (store.ts), so a pull's merge and checkout, or a push's pack, never load a
 * pack whole. ingest takes a fetched pack as it arrives (cf-git's _fetch
 * hands over its side-band stream, paced by the reader): stored by ranged
 * appends, indexed in the same pass (processor.ts), thin bases completed
 * from the repository, then named as git names it, pack before idx.
 */
import { encodeIdxV2 } from './idx.js';
import { oidToHex, PackFormatError } from './format.js';
import { PackStreamProcessor } from './processor.js';
import { packsSeam } from './store.js';
/** Pieces of a whole-file write: the session appends a piece in place below 512 KiB. */
const WRITE_PIECE_BYTES = 448 * 1024;
const READ_PIECE_BYTES = 4 * 1024 * 1024;
class SupervisorFileStore {
    supervisor;
    path;
    size = 0;
    constructor(supervisor, path) {
        this.supervisor = supervisor;
        this.path = path;
    }
    async append(bytes) {
        const at = this.size;
        this.size += bytes.byteLength;
        await this.supervisor.fsWriteRange(this.path, at, bytes);
    }
    async writeAt(offset, bytes) {
        await this.supervisor.fsWriteRange(this.path, offset, bytes);
    }
    async truncate(size) {
        this.size = size;
        await this.supervisor.fsTruncate(this.path, size);
    }
    async read(offset, length) {
        const out = new Uint8Array(length);
        for (let at = 0; at < length; at += READ_PIECE_BYTES) {
            const want = Math.min(READ_PIECE_BYTES, length - at);
            const piece = await this.supervisor.fsReadRange(this.path, offset + at, want);
            if (piece === null || piece.byteLength !== want)
                throw new PackFormatError(this.path + ': short read at ' + (offset + at));
            out.set(piece, at);
        }
        return out;
    }
}
async function* chunks(queue) {
    for (;;) {
        const { value, done } = await queue.next();
        if (done)
            break;
        if (value !== undefined)
            yield value;
    }
    if (queue.error)
        throw queue.error;
}
export function facetPacks(supervisor) {
    const fs = {
        async readRange(path, offset, length) {
            return (await supervisor.fsReadRange(path, offset, length)) ?? new Uint8Array(0);
        },
        readdir: (dir) => supervisor.readdir(dir),
    };
    const seam = packsSeam(fs);
    return {
        ...seam,
        async ingest(gitdir, packfile, readExternal) {
            const dir = gitdir + '/objects/pack';
            await supervisor.ensureDirectory(dir);
            const tmp = new SupervisorFileStore(supervisor, dir + '/tmp_pack_' + crypto.randomUUID());
            const external = {
                async read(oid) {
                    try {
                        const found = await readExternal(oidToHex(oid));
                        return { type: found.type, data: new Uint8Array(found.object) };
                    }
                    catch {
                        return null;
                    }
                },
            };
            // Within one invocation: a fetch's refs follow its pack in this call.
            const result = await new PackStreamProcessor({ store: tmp, external, budgetUnits: Number.POSITIVE_INFINITY }).run(chunks(packfile));
            if (result.entries === null)
                throw new PackFormatError('a fetched pack was not indexed');
            if (result.objects === 0) {
                await supervisor.unlink(tmp.path);
                return null;
            }
            const packSha = oidToHex(result.packSha);
            const name = dir + '/pack-' + packSha;
            if (await supervisor.size(name + '.idx') !== null) {
                // The same pack again: git keeps the one it has.
                await supervisor.unlink(tmp.path);
                return packSha;
            }
            await supervisor.rename(tmp.path, name + '.pack');
            const idx = new SupervisorFileStore(supervisor, dir + '/tmp_idx_' + crypto.randomUUID());
            const entries = result.entries;
            for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield entries; })) {
                for (let at = 0; at < piece.byteLength; at += WRITE_PIECE_BYTES)
                    await idx.append(piece.slice(at, at + WRITE_PIECE_BYTES));
            }
            await supervisor.rename(idx.path, name + '.idx');
            seam.refresh(gitdir);
            return packSha;
        },
    };
}
