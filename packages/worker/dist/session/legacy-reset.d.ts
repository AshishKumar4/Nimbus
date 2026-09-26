import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
/** What a session says when its files were written by a pre-v2 Nimbus. */
export declare const LEGACY_RESET_NOTICE = "This session's files were created by an older Nimbus and were reset: this version stores files differently and cannot read them.";
/**
 * The notice a session owes for a filesystem schema v2 did not read, once:
 * the persisted shell state goes with it (its cwd pointed into the lost
 * tree), so the session starts cold in the fresh one. Null when nothing
 * was lost, or it was already told.
 */
export declare function takeLegacyResetNotice(vfs: SqliteVFS, ctx: unknown): string | null;
//# sourceMappingURL=legacy-reset.d.ts.map