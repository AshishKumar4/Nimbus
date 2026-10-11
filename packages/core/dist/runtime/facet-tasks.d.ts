/** Guest entries compiled independently of the host's runtime/bootstrap modules. */
import type { FacetBindings } from './facet-host.js';
import type { CPythonFacetResult } from './cpython-runner.js';
import type { RubyFacetCallArgs } from './ruby-runner.js';
import type { BashBootArgs, BashFeedArgs } from './bash/types.js';
import type { WasiAbi } from './wasi-instance.js';
import type { WasiCred } from './wasi/types.js';
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
 * Facet-side entry. Serialized with fn.toString(), so it captures nothing and
 * names no import: everything it needs is on globalThis, put there by the
 * preamble.
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
}
export declare const clangFacetCall: (inArgs: {
    primaryName: string;
    argv: string[];
    cred: WasiCred;
    processPid: number;
}, facetEnv: FacetBindings) => Promise<ClangFacetResult>;
export declare const rubyFacetCall: (inArgs: RubyFacetCallArgs, facetEnv: {
    SUPERVISOR?: unknown;
}) => Promise<unknown>;
export declare const wasmFacetCall: (args: {
    mode: "direct" | "wasi";
    processPid?: number;
    liveOutput?: boolean;
    exportName?: string;
    intArgs?: number[];
    wasiArgv?: string[];
    wasiEnv?: Record<string, string>;
    wasiAbi?: WasiAbi;
    /**
     * The import namespace to bind, resolved supervisor-side.
     *
     * This function is serialized with fn.toString() and evaluated in the
     * facet isolate, where module imports do not exist — reaching for
     * WASI_ABI_NAMESPACE here is a ReferenceError at instantiate time that
     * surfaces as "wasi trap: instantiate failed", with the guest blamed
     * for a defect in the host. Values the facet needs travel as arguments.
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
    wasiFs?: {
        root: string;
        preopens: Array<{
            wasiPath: string;
            vfsPath: string;
        }>;
        cred?: {
            uid: number;
            gid: number;
            groups: number[];
        };
    };
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
    fsDiff?: {
        filesWritten: Record<string, string>;
        filesDeleted: string[];
        dirsCreated: string[];
        dirsDeleted: string[];
    };
};
//# sourceMappingURL=facet-tasks.d.ts.map