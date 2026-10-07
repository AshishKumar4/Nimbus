/**
 * The namespace as every wave's router (SqliteVFS.setWaveRouter). A W7 wave
 * is streamed to the session's SQLite filesystem, whoever sends it (a
 * process's binding, or a command holding the engine), and each of its
 * records lands where the namespace puts a mutation of that name: its
 * directory resolved by the mutations' own lookup (CompositeVFS
 * .mutationRoute, links followed into mounts), and the name placed by the
 * mount table. A record placed on a mount is applied there by the
 * namespace's own operations, so a mount's guard, read-only flag and
 * refusals are the record's as they are a single call's.
 *
 * A routed record behaves as the single operations a program would make on
 * that mount, at the place the lookup resolved, re-resolved nowhere:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: writeFile with its first chunk (truncating it, following a
 *     link at its name, keeping an existing file's mode, owner and inode, as
 *     open(O_TRUNC) does), then each further chunk written at its offset
 *     into that same file as the wave delivers it, its credit released once
 *     written; a backend that writes no ranges takes the file whole instead,
 *     up to HELD_FILE_BYTES, ENOTSUP past it;
 *   - a link: made at a staged name beside it, then renamed over it (as
 *     ln -sf does), so a backend that cannot make it refuses before the old
 *     entry goes;
 *   - a removal: rm -r, refused (naming what stayed) when it kept or failed
 *     to remove anything.
 * Every call of a record first checks that its directory still resolves to
 * where the record was placed, and a file's further chunks that its name is
 * still the inode the first chunk wrote: one that moved refuses the record
 * (ESTALE) rather than writing elsewhere.
 *
 * A staged link is named `.<name>.nimbus-wave`, beside its name. One a
 * crash left behind is removed by the next wave that makes a link of that
 * name, or by any wave making a link in that directory once it is older
 * than STAGED_LINK_STALE_MS.
 */
import type { CompositeVFS } from '../vfs/composite.js';
import type { WaveRouter } from '../vfs/sqlite-vfs.js';
import type { VfsCred } from '../vfs/vfs.js';
/**
 * The most a wave holds of one file for a mount that cannot write ranges:
 * half the session's shared write credit, so a held file never starves the
 * wave of the credit its next chunk needs.
 */
export declare const HELD_FILE_BYTES: number;
/** The suffix of a link staged beside its name: `.<name>${STAGED_LINK_SUFFIX}`. */
export declare const STAGED_LINK_SUFFIX = ".nimbus-wave";
/** A staged link this old is a crash's leftover: a live one is renamed within the record. */
export declare const STAGED_LINK_STALE_MS = 60000;
export declare function namespaceWaveRouter(namespace: CompositeVFS, credential: (cred: VfsCred) => VfsCred): WaveRouter;
//# sourceMappingURL=wave-router.d.ts.map