/**
 * opencode-facet-runner.ts — facet runner for the staged opencode ESM bundle.
 *
 * opencode is ESM-only (its CLI entry uses top-level await, so it cannot be
 * bundled to CJS) and imports a broad set of node: builtins plus node:sqlite.
 * It therefore cannot run through the standard `new Function` CJS facet path
 * (that path wraps entry code in a function body, which forbids ESM syntax).
 *
 * Instead the bundle rides into the facet Worker Loader module map as a real
 * ESM module (`opencode-bundle.js`) and this runner is the mainModule that:
 *
 *   1. Builds the Nimbus VFS-backed node-compat `builtins` (node-shims.ts) at
 *      module-init scope over the per-invocation VFS snapshot bundle, and
 *      parks them on `globalThis.__nimbusOpencodeBuiltins`. The module map
 *      supplies `node:fs`, `node:fs/promises`, and `node:os` as bridge
 *      modules that re-export from that global, so opencode's filesystem and
 *      home-directory access (e.g. `~/.local/share/opencode`) lands in the
 *      live SQLite VFS via the supervisor bridge instead of hitting workerd's
 *      empty, read-only nodejs_compat filesystem (EPERM on mkdir).
 *   2. Installs the Bun-global polyfill (Bun.stdin.text, Bun.stringWidth,
 *      Bun.file, Bun.hash) — opencode references `Bun.*` even on node target.
 *   3. Seeds process.argv / env / cwd from the per-invocation constants.
 *   4. Captures stdout/stderr and process.exit.
 *   5. Imports the opencode bundle and invokes its exported nimbusMain()
 *      INSIDE the fetch handler. The bundle is built so its CLI is a deferred
 *      function rather than a module top-level await: workerd runs module TLA
 *      in "global scope", where the VFS supervisor RPC is a disallowed async
 *      I/O operation. Running from the handler gives opencode the request I/O
 *      context it needs.
 *
 * Builtins not bridged (path, process, util, url, crypto, stream, …) resolve
 * through workerd's nodejs_compat. node:sqlite is not provided by
 * nodejs_compat, so it is supplied as an override module in the facet map.
 */
/** Map-module specifier for the opencode ESM bundle. */
export declare const OPENCODE_BUNDLE_MODULE_NAME = "opencode-bundle.js";
/**
 * node:sqlite override module placed in the facet map. opencode statically
 * imports node:sqlite; workerd's nodejs_compat does not provide it, so the
 * static import would fail at link time and the whole module would never
 * load. This module satisfies the import. DatabaseSync throws a precise
 * diagnostic if actually constructed (the bash-tool/serve DB paths).
 */
export declare const OPENCODE_NODE_SQLITE_MODULE: string;
/**
 * Module-map entries for the VFS-backed node builtin bridges. The Worker
 * Loader requires non-`.js`/`.py` module names (like `node:fs`) to use the
 * explicit `{ js }` content form.
 */
export declare function opencodeBuiltinBridgeModules(): Record<string, {
    js: string;
}>;
export interface OpencodeRunnerOptions {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdin: string;
    /**
     * Serialized VFS snapshot bundle (the `_serializeBundleForFacet` IIFE
     * string). Provides sync VFS reads; async writes/mkdir flush live through
     * the SUPERVISOR RPC binding.
     */
    vfsBundle: string;
    /** Serialized VFS directory manifest (JSON) for readdir/stat coherence. */
    vfsManifest: string;
}
/**
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * stdout/stderr are buffered and returned in the JSON response.
 */
export declare function generateOpencodeRunnerCode(opts: OpencodeRunnerOptions): string;
//# sourceMappingURL=opencode-facet-runner.d.ts.map