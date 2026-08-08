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
/**
 * Module-map specifier for the yoga-layout WebAssembly.Module. OpenTUI lays
 * out every TUI frame with yoga; the runner parks the pre-compiled Module on
 * `globalThis.__nimbusYogaModule` so the bundle's patched loader instantiates
 * it instead of doing the blocked request-time WebAssembly.instantiate(bytes).
 */
export declare const YOGA_WASM_MODULE_NAME = "yoga.wasm";
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
export declare function opencodeBuiltinBridgeModules(attachedTty?: boolean): Record<string, {
    js: string;
}>;
export interface OpencodeRunnerOptions {
    argv: string[];
    env: Record<string, string>;
    cred: {
        uid: number;
        gid: number;
        groups: readonly number[];
        umask: number;
    };
    cwd: string;
    stdin: string;
    /** The node-compat shim source (fetchNodeShimsCode — the staged asset). */
    shimsCode: string;
    /**
     * Serialized VFS snapshot bundle (the `_serializeBundleForFacet` IIFE
     * string). Provides sync VFS reads; async writes/mkdir flush live through
     * the SUPERVISOR RPC binding.
     */
    vfsBundle: string;
    /** Serialized VFS directory manifest (JSON) for readdir/stat coherence. */
    vfsManifest: string;
    /** Serialized VFS inode metadata (JSON) for stat and permission checks. */
    vfsMetadata: string;
    /** The coherence cursor the snapshot above was read at, as a JSON literal. */
    vfsCursor: string;
    /**
     * Runtime disposition of this opencode invocation:
     *   - 'oneshot'  buffer stdout/stderr into the JSON response and return
     *                (opencode run / models / --version).
     *   - 'attached' drive opencode's real createCliRenderer path: stdout/stderr
     *                stream LIVE to the SUPERVISOR (→ xterm), the live stdin pump
     *                (SUPERVISOR.cpReadStdin → process.stdin, with setRawMode/
     *                resize/signal) feeds keystrokes, and the facet stays alive on
     *                workerCtx.waitUntil until opencode exits. The env must carry
     *                NIMBUS_ATTACHED_TTY=1 + NIMBUS_CP_CHILD_PID so the shim TTY
     *                activates its raw-mode stdin and columns/rows.
     *   - 'server'   run a headless `opencode serve` HTTP server: no renderer, no
     *                stdin pump, logs stream live, the facet stays resident, and
     *                routed HTTP (the in-session loopback + external /port/<n>)
     *                is dispatched to the in-facet server via handleHttpRequest.
     */
    mode: OpencodeRunnerMode;
}
export type OpencodeRunnerMode = 'oneshot' | 'attached' | 'server';
/** OpenTUI's cross-copy singleton registry key (@opentui/core, public). */
export declare const OPENTUI_SINGLETON_SYMBOL = "@opentui/core/singleton";
/** The registry entry holding the live CliRenderer set. */
export declare const OPENTUI_RENDERER_TRACKER = "RendererTracker";
/**
 * Terminal-geometry bridge: SIGWINCH → the live renderers' resize().
 *
 * OpenTUI's CliRenderer subscribes to SIGWINCH itself ONLY when its stdout is
 * process.stdout (`_usesProcessStdout`); with a custom stdout the embedding host
 * owns the terminal and drives `renderer.resize(columns, rows)` — the same public
 * geometry API createTestRenderer exposes. Seam 7 hands the renderer the facet
 * TTY stdout (a distinct object, so the span feed gets allocated), which puts
 * Nimbus on exactly that host path. But that stdout IS the process terminal:
 * without this bridge a resize travels the whole way in — WS frame →
 * ProcessInputStore → cpReadStdin → node-shims updates __nimbusTtyColumns/Rows
 * and emits SIGWINCH — and then dies unheard, so the frame never reflows.
 *
 * Live renderers come from OpenTUI's own cross-copy registry (the same one that
 * enforces one renderer per stream). resize() runs the reflow immediately rather
 * than through handleResize's 100ms debounce, a facet timer that only fires on
 * the next I/O yield anyway.
 */
export declare const OPENTUI_RESIZE_BRIDGE_SRC: string;
/**
 * In-isolate Web Worker polyfill for the opencode TUI client/server split.
 *
 * opencode's TUI (the bare `opencode` process) is a CLIENT that spawns its API
 * SERVER as `new Worker("./worker.js", {env})` and talks to it over birpc
 * (cli/cmd/tui/worker.ts). OpenTUI's syntax-highlight tree-sitter parser
 * likewise runs in `new Worker("./parser.worker.js")`. On a real platform each
 * is a separate OS thread / V8 isolate; on workerd there is one isolate per
 * facet and no real `Worker` global (node-shims stubs worker_threads.Worker as
 * a no-op), so `client.call(...)` hangs forever before the renderer mounts.
 *
 * This polyfill runs BOTH the client and the worker module in the same isolate,
 * cooperating over an in-memory MessageChannel. `new Worker(file, opts)`:
 *
 *   1. Maps the worker `file` (`./worker.js` / `./parser.worker.js`) to its
 *      staged module-map specifier.
 *   2. Builds a worker-side context (the `__nimbusWorker` the worker bundle's
 *      build-time banner claims via globalThis.__nimbusWorkerClaim) carrying
 *      the worker's own `postMessage` (→ the Worker instance's message
 *      listeners) and `onmessage` (← messages the client posts). `self` members
 *      other than messaging fall through to globalThis.
 *   3. Parks that context for the claim, then dynamically imports the staged
 *      worker module — running its top-level (Rpc.listen / OTUI parser setup),
 *      which installs `context.onmessage`.
 *   4. Bridges the two directions: the Worker instance's postMessage delivers to
 *      the worker context's onmessage; the worker's postMessage delivers to the
 *      instance's message listeners. Messages sent before the worker installs
 *      its handler are buffered and flushed on install.
 *
 * The Worker instance exposes the EventEmitter + DOM surface opencode uses:
 * `onmessage`, `onerror`, `postMessage`, `terminate`, and `on/once/off/
 * addEventListener/removeEventListener` for `message`/`error`. Only wired in
 * attachedTty mode (the one-shot path never reaches the TUI command).
 */
export declare const WORKER_POLYFILL_SRC: string;
/**
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * One-shot mode buffers stdout/stderr into the JSON response; attachedTty mode
 * streams them live and keeps the facet alive for the interactive TUI.
 */
export declare function generateOpencodeRunnerCode(opts: OpencodeRunnerOptions): string;
//# sourceMappingURL=opencode-facet-runner.d.ts.map