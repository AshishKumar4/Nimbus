/**
 * git/pack/facet-packs.ts — cf-git's `packs` seam inside the git network
 * facet, over the supervisor's ranged reads and writes.
 *
 * read/has/expand serve objects from the session's packs by range
 * (store.ts), so a pull's merge and checkout, or a push's pack, never load a
 * pack whole. ingest takes a fetched pack as it arrives (cf-git's _fetch
 * hands over its side-band stream, paced by the reader): stored by ranged
 * appends, indexed in the same pass (processor.ts), thin bases completed
 * from the repository, then installed (install.ts) as git names it, pack
 * before idx; a fetch that fails leaves no temporary file behind.
 */
import { oidToHex } from './format.js';
import { installPack, RangedPackFile } from './install.js';
import { PackStreamProcessor } from './processor.js';
import { packsSeam } from './store.js';
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
            const files = { ...supervisor, remove: (path) => supervisor.unlink(path) };
            const tmpName = 'tmp_pack_' + crypto.randomUUID();
            const tmp = new RangedPackFile(files, dir + '/' + tmpName);
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
            try {
                // Within one invocation: a fetch's refs follow its pack in this call.
                const result = await new PackStreamProcessor({ store: tmp, external, budgetUnits: Number.POSITIVE_INFINITY }).run(chunks(packfile));
                const summary = await installPack(files, { dir, tmpName, result });
                if (summary !== null)
                    seam.refresh(gitdir);
                return summary?.packSha ?? null;
            }
            catch (error) {
                // A failed fetch leaves no temporary pack or idx behind (git's tmp_pack_ and tmp_idx_).
                for (const name of await supervisor.readdir(dir).catch(() => [])) {
                    if (name === tmpName || name === 'tmp_idx_' + tmpName.slice('tmp_pack_'.length)) {
                        await supervisor.unlink(dir + '/' + name).catch(() => undefined);
                    }
                }
                throw error;
            }
        },
    };
}
