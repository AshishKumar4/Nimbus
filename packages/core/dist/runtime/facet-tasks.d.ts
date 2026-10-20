import type { FacetBindings } from './facet-host.js';
import type { CPythonFacetResult } from './cpython-runner.js';
import type { RubyFacetCallArgs } from './ruby-runner.js';
import type { BashBootArgs, BashFeedArgs } from './bash/types.js';
import type { WasiAbi, WasiFsSnapshot } from './wasi-instance.js';
import type { RuntimeFsBridge, VfsCred } from './os-contracts.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
export type BashStepArgs = BashBootArgs | BashFeedArgs;
/** The step the classic submit transport carries: args object in, slice out.
 *  Serialized verbatim into the facet — every name it touches must be
 *  reachable there (globals or its own literals). */
export declare function bashFacetStep(args: BashStepArgs, bindings: FacetBindings): Promise<unknown>;
/**
 * The same step reached through a Request, for hosts whose facet can carry
 * a fetch signal. Serialized verbatim like `bashFacetStep` — no closure
 * references — and the dispatch inside is the same `__bashStep` call; only
 * the transport wrapper differs (JSON in, Response out).
 */
export declare function bashRequestStep(request: Request, bindings: FacetBindings): Promise<Response>;
/**
 * Facet-side entry, compiled as a task expression at build time. The
 * interpreter is installed on globalThis by the facet's preamble.
 */
export declare function cpythonRunFacetFn(args: Record<string, unknown>, facetEnv: {
    SUPERVISOR?: unknown;
} | undefined): Promise<CPythonFacetResult>;
export interface ClangFacetResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
    /** The toolchain's filesystem calls and who answered them (wasi/resident-filesystem.ts). */
    fsStats?: ResidentFilesystemStats | null;
    /** Whether its worker may run another process (__wasiReusable). */
    reusable?: boolean;
}
export declare const clangFacetCall: (inArgs: {
    primaryName: string;
    argv: string[];
    cred: VfsCred;
    processPid: number;
}, facetEnv: FacetBindings) => Promise<ClangFacetResult>;
export declare const rubyFacetCall: (inArgs: RubyFacetCallArgs, facetEnv: {
    SUPERVISOR?: unknown;
}) => Promise<unknown>;
export declare const wasmFacetCall: (args: {
    mode: "direct" | "wasi";
    processPid?: number;
    exportName?: string;
    intArgs?: number[];
    wasiArgv?: string[];
    wasiEnv?: Record<string, string>;
    wasiAbi?: WasiAbi;
    /**
     * The import namespace to bind, resolved supervisor-side.
     *
     * The host has already inspected the binary's ABI, so the namespace
     * travels with that result rather than being re-derived in the guest.
     */
    wasiNamespace?: string;
    /**
     * Present only for a wasi-threads build. Carries the imported memory's
     * declared limits, which the host must reproduce exactly — read from
     * the binary supervisor-side because the JS API exposes an import's
     * name but not its type.
     */
    threads?: {
        memory: {
            module: string;
            name: string;
            initial: number;
            maximum: number;
        };
    };
    wasiFs?: WasiFsSnapshot;
}, facetEnv?: {
    SUPERVISOR?: unknown;
}) => Promise<WasmCallResult>;
export type WasmCallResult = {
    ok: boolean;
    mode: 'direct' | 'wasi';
    result?: number | string;
    exports?: string[];
    stdout?: string;
    stderr?: string;
    streamedOutput?: boolean;
    exitCode?: number;
    error?: string;
    fsStats?: ResidentFilesystemStats | null;
};
/** What a tsrs run is: its command line, its directory and environment, and who runs it. */
export interface TsrsFacetArgs {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    cred: VfsCred;
    /** The session pid the compiler runs as (its runtime process). */
    processPid: number;
}
/** How a tsrs run ended; its output went to the session as it was written. */
export interface TsrsFacetResult {
    exitCode: number;
    error?: string;
    /** The compiler's linear memory at its end: its peak, since a wasm memory never shrinks. */
    memoryBytes?: number;
    fsStats?: ResidentFilesystemStats | null;
    /** Whether another run may take this worker (__wasiReusable): no syscall of this one was abandoned. */
    reusable?: boolean;
}
/**
 * One of tsrs's file operations (its `tsrs_host.fs` import, @tsrs/wasm's
 * core.js), answered from `fs`: the bytes to hand back, or null for a path
 * that does not exist. `request` is the operation's path, and for a write
 * the path, a NUL and the bytes; the times of a chtimes follow its path the
 * same way, as two NUL-separated decimal nanosecond counts.
 */
export declare function tsrsFileOperation(fs: RuntimeFsBridge, op: number, request: Uint8Array): Promise<Uint8Array | string | null>;
/**
 * Runs in the facet: one tsc invocation of tsrs.wasm (@tsrs/wasm), a fresh
 * instance, the module's own `tsrs_input` / `tsrs_run` protocol. Its files
 * are the process's resident filesystem (wasi/resident-filesystem.ts), so
 * tsrs is a WASI guest like any other: the store answers what it holds, a
 * miss asks the session, and what it writes settles before its exit status.
 * The module calls its file import synchronously; the import suspends the
 * run (JSPI) while the filesystem answers.
 */
export declare function tsrsFacetCall(args: TsrsFacetArgs, facetEnv: FacetBindings): Promise<TsrsFacetResult>;
//# sourceMappingURL=facet-tasks.d.ts.map