/**
 * The namespace as every wave's router (SqliteVFS.setWaveRouter). A W7 wave
 * is streamed to the session's SQLite filesystem, whoever sends it (a
 * process's binding, or a command holding the engine), and each of its
 * records lands where the namespace puts a mutation of that name: its
 * directory resolved by the mutations' own lookup (CompositeVFS
 * .mutationRoute, links followed into mounts), and the record applied on a
 * mount by the namespace's own operations, so a mount's guard, read-only
 * flag and refusals are the wave's as they are a single call's.
 *
 * On a mount, a record is applied as an upsert is, by the operations a
 * program would use, each refusal before anything is lost:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: written to a staged name in its directory chunk by chunk as
 *     the wave delivers them (each chunk's credit released once written),
 *     then renamed over its name; on a backend that cannot write a range,
 *     taken whole up to HELD_FILE_BYTES, ENOTSUP past it;
 *   - a link: made at a staged name, then renamed over its name, so a
 *     backend that cannot make it refuses before the old entry goes;
 *   - a removal: rm -r, refused (EIO, naming what stayed) when it kept or
 *     failed to remove anything.
 */
import type { CompositeVFS } from '../vfs/composite.js';
import type { WaveRouter } from '../vfs/sqlite-vfs.js';
import type { VfsCred } from '../vfs/vfs.js';
/**
 * The most a wave holds of one file for a mount that cannot write in place:
 * half the session's shared write credit, so a held file never starves the
 * wave of the credit its next chunk needs.
 */
export declare const HELD_FILE_BYTES: number;
export declare function namespaceWaveRouter(namespace: CompositeVFS, credential: (cred: VfsCred) => VfsCred): WaveRouter;
//# sourceMappingURL=wave-router.d.ts.map