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
 * A routed record is the single call a program would make on that mount,
 * at the place the lookup resolved:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: one whole-file writeFile (following a link at its name,
 *     keeping an existing file's mode, owner and inode), its bytes held
 *     under the wave's credit until that call, up to ROUTED_FILE_MAX;
 *   - a link: made at the wave's own slot beside its name, then renamed
 *     over it (as ln -sf does), so a backend that cannot make it refuses
 *     before the old entry goes;
 *   - a removal: rm -r, refused (naming what stayed) when it kept or failed
 *     to remove anything.
 * Each call first checks that the record's directory still resolves to the
 * place it was given; one that moved refuses the record (ESTALE).
 *
 * A link's slot is `.<name>.nimbus-wave-<wave>-<record>`, the wave's own:
 * no other operation's slot is touched. A wave that fails between the slot
 * and the rename removes its slot; a crash in that window leaves it, at
 * most one per link record in flight (a known leak, by that name pattern).
 */
import type { CompositeVFS } from '../vfs/composite.js';
import type { WaveRouter } from '../vfs/sqlite-vfs.js';
import type { VfsCred } from '../vfs/vfs.js';
/** The suffix of a link's slot: `.<name>${LINK_SLOT_SUFFIX}-<wave>-<record>`. */
export declare const LINK_SLOT_SUFFIX = ".nimbus-wave";
export declare function namespaceWaveRouter(namespace: CompositeVFS, credential: (cred: VfsCred) => VfsCred): WaveRouter;
//# sourceMappingURL=wave-router.d.ts.map