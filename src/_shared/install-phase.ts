/**
 * _shared/install-phase.ts — single source of truth for the npm-install
 * state-machine phase enum.
 *
 * History: CLN-1 (2026-05-11) — consolidated from two diverged copies.
 *   - `npm/installer.ts:93-95` was the progress-event variant. Included
 *     'lock-check' (a real progress event emitted while parsing
 *     package-lock.json) but lacked 'idle'.
 *   - `observability/diag-counters.ts:33-35` was the counter-state variant.
 *     Included 'idle' (the resting state when no install is in flight)
 *     but lacked 'lock-check'. The diag-counter's `setInstallPhase()`
 *     was actually called with 'idle' (installer.ts:184,201) — passing
 *     a value not declared in installer.ts's local type. The type check
 *     fell through to diag-counters' type because installer.ts imports
 *     setInstallPhase from there; the local `InstallPhase` definition
 *     in installer.ts was only used by `InstallProgress.phase`.
 *
 * Going forward both consumers import from this module; any new phase
 * value added here is automatically available everywhere.
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
export type InstallPhase =
  | 'idle'
  | 'lock-check'
  | 'resolve'
  | 'hoist'
  | 'diff'
  | 'fetch'
  | 'write'
  | 'link-bins'
  | 'bundle'
  | 'done';
