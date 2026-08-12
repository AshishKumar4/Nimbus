/**
 * runtime-registry.ts — shared shell-command factory for runtime
 * dispatchers (node, bun, and future native-WASM / Python / Ruby /
 * AssemblyScript runtimes).
 *
 * Why this exists
 * ───────────────
 * `node` and `bun` shell-command handlers in src/session/init.ts
 * shared ~85% of their code: argv parsing for --version / --help /
 * -e / script-path, VFS lookup, shebang strip, esbuild transform for
 * .ts/.tsx/.jsx, dispatch to the runner. The duplication had drifted
 * — only `node` had the primitive #1 nodeFlagSpan fix
 * (init.ts:233-243), only `node` had primitive-#2 binSpawn ctx
 * propagation (init.ts:391-403), only `bun` had install / run
 * subcommand routing.
 *
 * `buildRuntimeHandler` returns a single shell-handler function that
 * encodes the shared contract. Per-runtime variation is supplied
 * via the `RuntimeSpec` parameter:
 *
 *   - name + version + helpText
 *   - run(): runner fn (runFresh / runBunScript / wasm-runner)
 *   - subcommands: optional map of `<verb> → handler` for
 *     bun-style `bun install`, `bun run` (node has none today)
 *   - transform(): optional code rewriter (bun prepends BUN_SHIM_PREAMBLE)
 *   - supportsBinSpawn: true for node (the .bin handler propagates
 *     a callerPid); other runtimes use a plain spawn flow.
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / NO retry / NO defensive-catch added.
 *   - NO behavioral change vs the pre-refactor handlers — every
 *     runtime-specific quirk is preserved exactly.
 *   - Per-runtime test parity: existing runtime-primitives probes
 *     (#1 npx / #2 .bin) and runtime-pkg probes (G1-G4) MUST still
 *     pass against the refactored handlers — the contract is
 *     observable behaviour, not implementation shape.
 */
import type { FacetManager } from '../facets/manager.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { type VfsCred } from './os-contracts.js';
import type { EsbuildService } from './esbuild-service.js';
import { type FacetBundleProfile } from './bundle-profile.js';
/**
 * Result shape that runtime-registry expects from a runner. Mirrors
 * the existing RunFreshResult / RunBunResult shapes — kept narrow so
 * future runtimes don't have to plumb runtime-internal state.
 */
export interface RuntimeRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
/**
 * Options the handler passes to the runner. Mirrors RunFreshOpts.
 */
export interface RuntimeRunOpts {
    argv: string[];
    env: Record<string, string> | undefined;
    cwd: string | undefined;
    filename: string;
    dirname: string;
    command: string;
    /** Primitive #1/G4 hooks. node-runner consumes these; other
     *  runtimes ignore them safely. */
    skipSpawn?: boolean;
    callerPid?: number;
    /** Capture stdout/stderr in the result instead of streaming to the
     *  terminal supervisor. Used by child_process pipe semantics. */
    captureOutput?: boolean;
    forceLongRunning?: boolean;
    attachedTty?: boolean;
    bundleProfile?: FacetBundleProfile;
    /** Invoking process credentials for credential-bound runtime snapshots. */
    cred?: VfsCred;
}
/** The VFS surface script resolution needs. */
export interface ScriptResolutionFs {
    isFile(path: string): boolean;
    readFileString(path: string): string;
}
/**
 * Resolve a runtime target — `./cli.ts`, `sub/x`, `.`, or a bare name — to a
 * canonical VFS key, or null when nothing runnable sits there.
 *
 * A directory never resolves to itself: it falls through to the index
 * candidates, so `bun ./tools` finds `tools/index.js` the way real bun does
 * rather than trying to read the directory as source.
 */
export declare function resolveRuntimeScriptPath(fs: ScriptResolutionFs, cwd: string, target: string, opts?: {
    preferModuleField?: boolean;
}): string | null;
/**
 * A subcommand handler. `runAsRuntime` re-enters the standard flow — flag
 * span, script resolution, transform, exec — with a rewritten argv, as if
 * the verb had never been typed. `bun run <file>` uses it to hand a path
 * to the very same execution path `bun <file>` takes, rather than growing
 * a second one.
 */
export type RuntimeSubcommand = (ctx: any, registry: ShellRegistry, runAsRuntime: (args: string[]) => Promise<number>) => Promise<number>;
export interface RuntimeSpec {
    /** Shell-command name: 'node' / 'bun' / 'wasm-runner' / 'python'. */
    name: string;
    /** Output of `<name> --version`. Includes the leading 'v' if the
     *  runtime convention does (Node: 'v20.0.0'; Bun: '1.1.42'). */
    version: string;
    /** Multi-line help text for `<name> --help`. */
    helpText: string;
    /**
     * Runner function. Usually wraps facetMgr.exec / facetMgr.spawn.
     * For native-WASM, this is a thin WebAssembly.instantiate +
     * function-call helper.
     */
    run(facetMgr: FacetManager, code: string, opts: RuntimeRunOpts): Promise<RuntimeRunResult>;
    /**
     * Subcommand router. When the first positional arg is a key in
     * this map, the handler is invoked instead of the standard
     * script-execution flow. Used by `bun install`, `bun run <script>`.
     */
    subcommands?: Record<string, RuntimeSubcommand>;
    /**
     * When true, the runtime treats the args list as a binary file
     * path (NOT a JS script). Used by `wasm-runner` — the args[0] is a
     * .wasm path, args[1+] are the function name + integer args.
     * The handler skips the read-and-transform-script flow and calls
     * `run()` with a synthetic empty `code` — runtimes that set this
     * flag implement the actual bytes-load inside their runner.
     */
    bypassesScriptRead?: boolean;
    /**
     * Primitive #1 / G4 — when true, the script-execution branch
     * propagates `ctx.__nimbusBinSpawn` into RuntimeRunOpts. Only
     * `node` enables this; bun's runFresh chain doesn't share PID
     * state with the .bin handler today. Future runtimes set this
     * iff they share the runFresh contract.
     */
    supportsBinSpawn?: boolean;
}
/**
 * Minimal registry shape we depend on. Avoids importing the full vendored
 * shell registry type tree when the runtime path only needs resolve().
 */
export interface ShellRegistry {
    resolve(name: string): Promise<any> | any;
}
/**
 * Build a shell-handler function for a runtime. The returned function
 * is the value passed to `registry.register('<name>', handler)`.
 *
 * Captures `vfs`, `facetMgr`, `esbuild`, `getEsbuild` (for lazy init)
 * + the spec. The same factory is used for every runtime; the only
 * runtime-specific code lives in `spec`.
 */
export declare function buildRuntimeHandler(spec: RuntimeSpec, ctx0: {
    vfs: SqliteVFS;
    facetMgr: FacetManager;
    /** Lazy esbuild initialiser. Called once per first .ts/.tsx/.jsx
     *  invocation — the host owns the init lifecycle. */
    getEsbuild(): EsbuildService;
    registry: ShellRegistry;
}): (ctx: any) => Promise<number>;
//# sourceMappingURL=runtime-registry.d.ts.map