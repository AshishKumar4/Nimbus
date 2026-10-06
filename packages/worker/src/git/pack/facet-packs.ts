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
import { installPack, RangedPackFile, type PackFiles } from './install.js';
import { PackStreamProcessor } from './processor.js';
import { packsSeam, type GitPacksSeam, type PackStoreFs } from './store.js';
import type { ResolvedObject } from './reader.js';
import type { GitObjectType } from './format.js';

/** The supervisor calls the seam makes. */
export interface FacetPacksSupervisor {
  fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  fsWriteRange(path: string, offset: number, bytes: Uint8Array): Promise<unknown>;
  fsTruncate(path: string, size: number): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  /** Make `dir` exist durably (a clone's objects/pack may not yet). */
  ensureDirectory(dir: string): Promise<void>;
}

/** cf-git's FIFO of pack chunks (its side-band demux's band 1). */
export interface PackChunkQueue {
  next(): Promise<{ value?: Uint8Array; done?: boolean }>;
  error?: unknown;
}

/** cf-git's _readObject, for a thin pack's bases. */
export type ExternalObjectReader = (oid: string) => Promise<{ type: string; object: Uint8Array }>;

export interface FacetPacksSeam extends GitPacksSeam {
  /** Store and index a fetched pack; its id, or null for an empty pack. */
  ingest(gitdir: string, packfile: PackChunkQueue, readExternal: ExternalObjectReader): Promise<string | null>;
}

async function* chunks(queue: PackChunkQueue): AsyncGenerator<Uint8Array> {
  for (;;) {
    const { value, done } = await queue.next();
    if (done) break;
    if (value !== undefined) yield value;
  }
  if (queue.error) throw queue.error;
}

export function facetPacks(supervisor: FacetPacksSupervisor): FacetPacksSeam {
  const fs: PackStoreFs = {
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
      const files: PackFiles = {
        ...supervisor,
        remove: (path) => supervisor.unlink(path),
        // One ranged write a file (a fetch installs one pack: a wave buys nothing here).
        async writeFiles(list, _durable) {
          for (const file of list) await new RangedPackFile(files, file.path).append(file.bytes);
        },
      };
      const tmpName = 'tmp_pack_' + crypto.randomUUID();
      const tmp = new RangedPackFile(files, dir + '/' + tmpName);
      const external = {
        async read(oid: Uint8Array): Promise<ResolvedObject | null> {
          try {
            const found = await readExternal(oidToHex(oid));
            return { type: found.type as GitObjectType, data: new Uint8Array(found.object) };
          } catch {
            return null;
          }
        },
      };
      try {
        // Within one invocation: a fetch's refs follow its pack in this call.
        const result = await new PackStreamProcessor({ store: tmp, external, budgetUnits: Number.POSITIVE_INFINITY }).run(chunks(packfile));
        const summary = await installPack(files, { dir, tmpName, result });
        if (summary !== null) seam.refresh(gitdir);
        return summary?.packSha ?? null;
      } catch (error) {
        // A failed fetch leaves no temporary pack, idx or rev behind (git's tmp_pack_, tmp_idx_, tmp_rev_).
        for (const name of await supervisor.readdir(dir).catch(() => [] as string[])) {
          const id = tmpName.slice('tmp_pack_'.length);
          if (name === tmpName || name === 'tmp_idx_' + id || name === 'tmp_rev_' + id) {
            await supervisor.unlink(dir + '/' + name).catch(() => undefined);
          }
        }
        throw error;
      }
    },
  };
}
