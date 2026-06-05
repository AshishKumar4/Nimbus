/**
 * seed-project.ts — Materialize a polished Vite + React + TS + Tailwind +
 * React Router starter at /home/user/app on first boot.
 *
 * Invariants:
 *   - Idempotent: won't re-seed once the sentinel (~/.nimbus-seeded) exists.
 *   - Atomic-ish: file bodies written in ONE writeBatch(); sentinel written
 *     in a SECOND writeBatch() so a crash between the two re-runs the whole
 *     seed on next boot (writeFile is idempotent, so retry is safe).
 *   - User escape hatch: `rm -rf ~/app ~/.nimbus-seeded` → next session
 *     regenerates from factory defaults (hard reset semantics).
 *
 * Design choices (see plan):
 *   - Root: /home/user/app (doesn't pollute the home dir)
 *   - Polished deps: react-router, framer-motion, lucide-react, tailwindcss
 *   - No pre-install of node_modules (~200MB; let the user see install run)
 *   - No auto-start of vite (surprising; README says `npm run dev`)
 *   - Basename injection (commit 2) handles the /preview/ basepath wiring.
 */
import type { SqliteVFS } from './sqlite-vfs.js';
/** Sentinel: if present, seed never runs again (until user deletes it). */
export declare const SEED_SENTINEL_PATH = "home/user/.nimbus-seeded";
/** Project root. Absolute VFS path (no leading slash). */
export declare const SEED_PROJECT_DIR = "home/user/app";
export interface SeedFile {
    /** VFS path, no leading slash. */
    path: string;
    content: string;
}
export declare const SEED_FILES: SeedFile[];
/**
 * Should we run the starter-project seed?
 * Returns false if:
 *   - Sentinel exists (already seeded; user can `rm ~/.nimbus-seeded` to opt in again)
 *   - Project dir already exists (user has their own ~/app we must not clobber)
 */
export declare function shouldSeedProject(vfs: SqliteVFS): boolean;
/**
 * Returns true if the sentinel is present (seed has completed at least once).
 * Used to gate MOTD hints about the starter app.
 */
export declare function hasSeededProject(vfs: SqliteVFS): boolean;
/**
 * Materialize the seed project.
 *
 * Two-phase write for crash recovery:
 *   1. Write all file bodies + directory inodes in ONE writeBatch().
 *   2. Only on success, write the sentinel in a SEPARATE writeBatch().
 *
 * If the process dies between (1) and (2), the next boot will re-run this
 * function (sentinel absent). All writes are `INSERT OR REPLACE` so retry
 * is idempotent. If (1) itself fails mid-transaction, sqlite rolls back and
 * we start clean next boot.
 */
export declare function seedProject(vfs: SqliteVFS, opts?: {
    log?: (msg: string) => void;
}): {
    seeded: boolean;
    files: number;
    reason?: string;
};
//# sourceMappingURL=seed-project.d.ts.map