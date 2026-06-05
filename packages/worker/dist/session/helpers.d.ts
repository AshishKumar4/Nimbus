/**
 * session/helpers.ts — pure helpers used by the supervisor.
 *
 * All functions here are pure: no class state and no `cloudflare:workers`
 * import. NimbusSession re-exports the public helpers that callers need.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
/**
 * Render a polished "no dev server" placeholder HTML page for the /preview/
 * route. Matches the Nimbus shell MOTD aesthetic (near-black background,
 * green monospace accents). Auto-reloads when /api/stats reports the named
 * service has flipped to `running: true`.
 *
 * All CSS inlined — no external deps so it works offline.
 */
export declare function renderNoDevServerHtml(opts: {
    /** Shell hint to display in the code block (already HTML-escaped). */
    hint: string;
    /** Fully-qualified URL path to poll (e.g. `/s/<id>/api/stats`). */
    polled: string;
    /** Stats field to watch for `.running === true`. */
    liveKey: 'vite' | 'wrangler';
}): string;
/**
 * Known bundler / framework CLIs that need node_modules to be usable.
 * If an npm script starts with one of these binaries, missing node_modules
 * is a hard error (exit 1) rather than a warning. Scripts that don't match
 * get a soft warning; the script runs anyway in case it's something like
 * `echo hi` that doesn't need deps at all.
 */
export declare const BUNDLER_BIN_PREFIXES: string[];
/**
 * Bins that can't execute inside a Durable Object isolate, with tailored
 * guidance for the user. These are commands that CAN install into
 * node_modules/.bin but that crash or hang at runtime because they depend
 * on primitives (child_process.spawn, native binaries, real sockets) that
 * Nimbus doesn't provide.
 *
 * Used by the `npm run` handler's Fix-1 pre-flight: if a script starts
 * with one of these bins, we short-circuit with a deterministic error
 * instead of letting it enter the shell.execute black hole.
 *
 * Keep the keys as the RAW bin name the user's script would invoke;
 * point to the Nimbus-native alternative if one exists.
 *
 * NOTE: `wrangler` is NOT here anymore — it's registered as a transparent
 * alias for `nimbus-wrangler` in initSession, so `npm run dev` with a
 * wrangler-based dev script Just Works via the DO-in-DO implementation.
 * If a user's Worker uses bindings that nimbus-wrangler can't provide
 * (durable_objects, assets, worker_loaders, etc.), the wrapper prints a
 * loud warning BEFORE building so there are no mysterious runtime errors.
 */
export declare const NIMBUS_UNSUPPORTED_BINS: Record<string, {
    reason: string;
    alternative?: string;
}>;
/**
 * wrangler CLI flags that have no meaning inside Nimbus (the DO provides
 * its own host/port/log routing). If present in a wrangler/npm-run-dev
 * invocation, we strip them silently rather than failing — user scripts
 * authored for real wrangler shouldn't need modification.
 *
 * Flags are matched by exact name; the following token (value) is also
 * consumed when the flag is a known "takes a value" variant.
 */
export declare const WRANGLER_IGNORED_FLAGS: Set<string>;
export declare const WRANGLER_IGNORED_FLAGS_WITH_VALUE: Set<string>;
/**
 * Strip wrangler-specific flags (and their values when applicable) from
 * an argv slice. Returns both the cleaned args AND the list of ignored
 * tokens so the caller can log them (once) for transparency.
 */
export declare function filterWranglerFlags(argv: string[]): {
    args: string[];
    ignored: string[];
};
/**
 * wrangler.jsonc binding fields that require real wrangler / the real
 * Cloudflare runtime with proper binding provisioning. nimbus-wrangler
 * can bundle the Worker and load it via env.LOADER, but these bindings
 * are not wired up — the Worker will get `undefined` when it tries to
 * access them, which is usually a runtime crash.
 *
 * We don't refuse to start — some Workers use these bindings only on
 * certain paths or in a way that a runtime-undefined value just causes
 * a specific endpoint to fail. We warn LOUDLY so users know why their
 * Worker might crash.
 */
export declare const WRANGLER_UNSUPPORTED_CONFIG_FIELDS: string[];
/**
 * Read the user's wrangler config from the VFS and return any field names
 * from WRANGLER_UNSUPPORTED_CONFIG_FIELDS that are present and non-empty.
 *
 * Best-effort: tolerates JSONC comments and syntax errors (returns [] on
 * parse failure). The caller decides whether to warn or block — we only
 * report; nimbus-wrangler itself still runs.
 */
export declare function detectUnsupportedWranglerConfig(vfs: SqliteVFS, root: string): string[];
/**
 * W8: classify a child_process spawn target by execution kind. Used by
 * the FacetProcessManager to decide between inline pure-builtin vs
 *
 *   pure-builtin  — sync, no facet recursion. echo, cat, true, false,
 *                   ls, cd, env, sleep, mkdir, rm, … (all the unix
 *                   command shims in src/unix-commands.ts).
 *   facet-direct  — needs a fresh isolate. node, npm, npx, git, sh,
 *                   bash, husky, lefthook, the wranglers, vite, …
 *   unknown       — exit 127.
 */
export declare const _CP_FACET_DIRECT: Set<string>;
export declare const _CP_PURE_BUILTIN: Set<string>;
/**
 * Classify a command name by kind. Returns null for unknown commands.
 *
 * Prefix-form rule: anything starting with `./`, `/`, or `node_modules/`
 * is treated as facet-direct so a registered bin script (or a node
 * fallthrough) can attempt to run it.
 */
export declare function _classifyCommand(name: string): {
    kind: 'pure-builtin' | 'facet-direct' | 'unknown';
} | null;
/**
 * Parse the first token of an npm script's command string and decide whether
 * it's a bundler/framework CLI that requires node_modules. Handles common
 * prefixes like `cross-env FOO=bar vite`, `node ./server.js`, and npx.
 *
 * Returns the detected bundler bin name (e.g. "vite") or null.
 */
export declare function detectBundlerBin(script: string): string | null;
/**
 * Check whether a project directory has installed dependencies.
 *
 * Returns { missing: true, depCount } if package.json declares deps AND
 * node_modules/ doesn't exist. `missing: false` when:
 *   - There's no package.json (we're not in a project, no guard needed)
 *   - package.json declares zero deps (no install needed)
 *   - node_modules/ exists (even if stale — caught by runtime error overlay)
 */
export declare function checkNodeModulesGuard(vfs: SqliteVFS, projectRoot: string): {
    missing: boolean;
    depCount: number;
};
//# sourceMappingURL=helpers.d.ts.map