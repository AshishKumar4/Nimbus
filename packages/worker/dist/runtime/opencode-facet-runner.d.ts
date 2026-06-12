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
 * nodejs_compat; it is bridged to the VFS-backed sql.js shim (the same
 * DatabaseSync the CJS facet path uses), and its wasm rides in via the module
 * map (see SQLITE_WASM_MODULE_NAME) and is booted before opencode opens the
 * DB at ~/.local/share/opencode/*.db.
 */
/** Map-module specifier for the opencode ESM bundle. */
export declare const OPENCODE_BUNDLE_MODULE_NAME = "opencode-bundle.js";
/** Module-map specifier for the sql.js WebAssembly.Module. */
export declare const SQLITE_WASM_MODULE_NAME = "sqlite.wasm";
/**
 * Runner argv sentinel for the tree-sitter wasm diagnostic. `opencode
 * __nimbus-tree-sitter-diag [command]` runs web-tree-sitter core init +
 * bash/powershell grammar loads + a bash parse through the bundle's OWN
 * (Nimbus-patched) web-tree-sitter instance — the exact module-map/registry
 * path the bash tool's parser uses — without needing a model. Reported as
 * JSON on stdout; probed by
 * tests/behavioral/agentic-cli/new/opencode-tree-sitter-bash-parse.mjs.
 */
export declare const OPENCODE_TREE_SITTER_DIAG_ARG = "__nimbus-tree-sitter-diag";
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
    /**
     * Interactive TUI mode. When set, the runner drives opencode's real
     * createCliRenderer path: stdout/stderr stream LIVE to the SUPERVISOR
     * (→ xterm) instead of being buffered, the live stdin pump
     * (SUPERVISOR.cpReadStdin → process.stdin, with setRawMode/resize/signal)
     * feeds keystrokes, and the facet stays alive on workerCtx.waitUntil until
     * opencode exits — the same attached-TTY substrate the long-running node
     * path (manager.ts) uses, but over the ESM bundle. The env must carry
     * NIMBUS_ATTACHED_TTY=1 + NIMBUS_CP_CHILD_PID so the shim TTY (node-shims.ts)
     * activates its raw-mode stdin and columns/rows.
     */
    attachedTty?: boolean;
}
/**
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * One-shot mode buffers stdout/stderr into the JSON response; attachedTty mode
 * streams them live and keeps the facet alive for the interactive TUI.
 */
export declare function generateOpencodeRunnerCode(opts: OpencodeRunnerOptions): string;
//# sourceMappingURL=opencode-facet-runner.d.ts.map