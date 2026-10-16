/**
 * _shared/install-phase.ts — single source of truth for the npm-install
 * state-machine phase enum.
 *
 * Every consumer imports it from here, so a phase added here is everyone's.
 *
 * Phase semantics (chronological order for a single install run):
 *
 *   idle         resting state, no install in flight
 *     ↓
 *   lock-check   parsing existing package-lock.json (if present)
 *     ↓
 *   resolve      walking the dep tree, fetching packuments
 *     ↓
 *   hoist        hoisting peer-deps + flattening node_modules
 *     ↓
 *   diff         comparing target tree against current install state
 *     ↓
 *   fetch        downloading missing tarballs
 *     ↓
 *   write        extracting tarballs into the VFS
 *     ↓
 *   link-bins    creating bin/ symlinks
 *     ↓
 *   bundle       (post-install) pre-bundling for esbuild fast path
 *     ↓
 *   done         install complete; about to return to 'idle'
 *
 * The phase strings are surfaced via /api/_diag/install-pipeline and
 * displayed in the install-progress UI; treat them as a public API.
 */
export type InstallPhase = 'idle' | 'lock-check' | 'resolve' | 'hoist' | 'diff' | 'fetch' | 'write' | 'link-bins' | 'bundle' | 'done';
//# sourceMappingURL=install-phase.d.ts.map