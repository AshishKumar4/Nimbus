/** Guest entries compiled independently of the host's runtime/bootstrap modules. */
import { errorText } from '../_shared/error-text.js';
import type { FacetBindings } from './facet-host.js';
import type { CPythonFacetResult } from './cpython-runner.js';
import type { RubyFacetCallArgs } from './ruby-runner.js';
import type { BashBootArgs, BashFeedArgs } from './bash/types.js';
import type { WasiAbi } from './wasi-instance.js';
import type { WasiCred, WasiInitOptions, WasiInstanceBundle, WasiMakeImportsOptions } from './wasi/types.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
export type BashStepArgs = BashBootArgs | BashFeedArgs;
/** The step the classic submit transport carries: args object in, slice out.
 *  Serialized verbatim into the facet — every name it touches must be
 *  reachable there (globals or its own literals). */
export async function bashFacetStep(args: BashStepArgs, bindings: FacetBindings): Promise<unknown> {
    const step: unknown = Reflect.get(globalThis, '__bashStep');
    return typeof step === 'function' ? step(args, bindings.SUPERVISOR) : {
        state: 'error',
        exitCode: 127,
        stdout: '',
        stderr: '',
        error: 'bash-runner preamble missing (__bashStep not in scope)',
    };
}
/**
 * The same step reached through a Request, for hosts whose facet can carry
 * a fetch signal. Serialized verbatim like `bashFacetStep` — no closure
 * references — and the dispatch inside is the same `__bashStep` call; only
 * the transport wrapper differs (JSON in, Response out).
 */
export async function bashRequestStep(request: Request, bindings: FacetBindings): Promise<Response> {
    const step: unknown = Reflect.get(globalThis, '__bashStep');
    if (typeof step !== 'function') {
        return Response.json({
            state: 'error',
            exitCode: 127,
            stdout: '',
            stderr: '',
            error: 'bash-runner preamble missing (__bashStep not in scope)',
        });
    }
    return Response.json(await step(await request.json(), bindings.SUPERVISOR));
}
/**
 * Facet-side entry, compiled as a task expression at build time. The
 * interpreter is installed on globalThis by the facet's preamble.
 */
export async function cpythonRunFacetFn(args: Record<string, unknown>, facetEnv: {
    SUPERVISOR?: unknown;
} | undefined): Promise<CPythonFacetResult> {
    const run = Reflect.get(globalThis, '__cpythonRun') as ((a: unknown) => Promise<CPythonFacetResult>) | undefined;
    if (typeof run !== 'function') {
        return {
            stdout: '', stderr: '', exitCode: 127,
            error: 'cpython preamble missing: __cpythonRun not in scope',
        };
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor') as ((s: unknown) => void) | undefined;
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where the boot re-adopts it after the mount: adopting only here
    // would be undone by __wasiInitFS, which clears it on purpose.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
    adopt?.(supervisor);
    return run(args);
}
export interface ClangFacetResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
    /** The toolchain's filesystem calls and who answered them (wasi/resident-filesystem.ts). */
    fsStats?: ResidentFilesystemStats | null;
}
export const clangFacetCall = async function clangFacetCall(inArgs: {
    primaryName: string;
    argv: string[];
    cred: WasiCred;
    processPid: number;
}, facetEnv: FacetBindings): Promise<ClangFacetResult> {
    const wasm = Reflect.get(globalThis, '__NIMBUS_WASM') as Record<string, unknown> | undefined;
    const primaryMod = wasm?.['primary.wasm'];
    if (!primaryMod) {
        return {
            exitCode: 127, stdout: '', stderr: '',
            error: 'clang-runner: __NIMBUS_WASM missing primary.wasm',
        };
    }
    const fn = Reflect.get(globalThis, '__clangRun') as ((a: unknown) => Promise<ClangFacetResult>) | undefined;
    if (typeof fn !== 'function') {
        return {
            exitCode: 127, stdout: '', stderr: '',
            error: 'clang-runner preamble missing: __clangRun not in scope',
        };
    }
    return await fn({
        primaryName: inArgs.primaryName,
        argv: inArgs.argv,
        cred: inArgs.cred,
        primaryMod,
        supervisor: facetEnv?.SUPERVISOR,
        processPid: inArgs.processPid,
    });
};
export const rubyFacetCall = async function rubyFacetCall(inArgs: RubyFacetCallArgs, facetEnv: {
    SUPERVISOR?: unknown;
}): Promise<unknown> {
    const fn = Reflect.get(globalThis, '__rubyRun');
    if (typeof fn !== 'function') {
        return { exitCode: 127, stdout: '', stderr: '',
            error: 'ruby-runner preamble missing: __rubyRun not in scope' };
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor') as ((s: unknown) => void) | undefined;
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where __rubyRun re-adopts it after the mount; adopting only
    // here would be undone by __wasiInitFS.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusRubySupervisor', supervisor);
    adopt?.(supervisor);
    return fn({
        userCode: inArgs.userCode,
        rbArgv: inArgs.rbArgv,
        userEnv: inArgs.userEnv,
        progName: inArgs.progName,
        binName: inArgs.binName,
        cwd: inArgs.cwd,
        cred: inArgs.cred,
        supervisorPid: inArgs.supervisorPid,
    });
};
// ── facet-side globals injected by the WASI preamble ─────────────────
// The preamble (WASI_INSTANCE_PREAMBLE_SRC) runs at facet module-init
// time and declares these top-level. The facet fn below references
// them; tsc needs to know they exist. Empty bodies — only types.
//
// The SHAPES come from runtime/wasi/types.ts, which is what the shim itself is
// written against. They used to be restated here by hand, and the copy had
// drifted: it omitted `parking` entirely and declared `getMemory` as returning a
// nullable memory, which the shim dereferences unguarded. A second description
// of one contract cannot be kept honest, so there is now only the one.
declare const __wasiMakeImports: (opts: WasiMakeImportsOptions) => WasiInstanceBundle;
declare const __wasiInitFS: (opts: WasiInitOptions) => void;
declare const __wasiAdoptSupervisor: (sup: unknown) => void;
declare const __wasiSupervisorOutput: (sup: unknown) => {
    stdoutBytes(bytes: Uint8Array): void | Promise<void>;
    stderrBytes(bytes: Uint8Array): void | Promise<void>;
    drain(): Promise<string | null>;
};
declare const __wasiFsStats: (() => ResidentFilesystemStats | null) | undefined;
/** The green-thread scheduler — see runtime/wasi-threads.ts. */
interface WasiThreadScheduler {
    hostImports: () => Record<string, WebAssembly.ModuleImports>;
}
declare const __wasiThreadsCreate: (opts: {
    memory: WebAssembly.Memory;
    startThread: (tid: number, startArg: number) => () => Promise<unknown>;
}) => WasiThreadScheduler;
declare const __wasiThreadsStarter: (module: WebAssembly.Module, importObject: Record<string, WebAssembly.ModuleImports>) => (tid: number, startArg: number) => () => Promise<unknown>;
declare const __wasiRunStartThreads: (instance: WebAssembly.Instance, sched: WasiThreadScheduler) => Promise<{
    exitCode: number;
    error?: string;
}>;
declare const __wasiRunStart: (instance: WebAssembly.Instance, ctx: {
    memory: WebAssembly.Memory;
}) => {
    exitCode: number;
    error?: string;
};
// WASI socket and polling support P3: async variant that wraps _start with WebAssembly.promising
// for JSPI-suspending imports (sock_send/recv/shutdown). Falls back to
// sync invocation when WebAssembly.promising is unavailable, so behaviour
// is identical for non-suspending wasm programs.
declare const __wasiRunStartAsync: (instance: WebAssembly.Instance, ctx: {
    memory: WebAssembly.Memory;
}) => Promise<{
    exitCode: number;
    error?: string;
}>;
type WasmDirectExport = (...args: number[]) => number | bigint | undefined;
export const wasmFacetCall = async function wasmFacetCall(args: {
    mode: 'direct' | 'wasi';
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
}): Promise<WasmCallResult> {
    const wasmTable = globalThis.__NIMBUS_WASM || {};
    const mod = wasmTable['user.wasm'];
    if (!mod) {
        return {
            ok: false,
            mode: args.mode,
            error: 'globalThis.__NIMBUS_WASM[\'user.wasm\'] not found — the facet ' +
                'host did not register the module. Internal error.',
        };
    }
    // ── WASI mode ──
    if (args.mode === 'wasi') {
        const mk = __wasiMakeImports;
        const runStart = __wasiRunStart;
        // WASI socket and polling support P3 / production compatibility fix: bare lexical reference, matching
        // the runStart pattern above. The earlier `(globalThis as any)
        // .__wasiRunStartAsync` lookup returned undefined at runtime
        // because top-level `function` declarations in the preamble's
        // ES-module scope do NOT auto-attach to globalThis. The result
        // was that sock_*/poll_oneoff (wrapped in WebAssembly.Suspending)
        // were invoked from a sync `_start` call stack → V8 trapped with
        // "trying to suspend without WebAssembly.promising". The 11
        // sync-only WASI socket and polling support probes worked because they never hit a
        // Suspending import; the 7 async probes failed because they did.
        // The preamble is statically prepended to this same module body
        // (fabric/isolate-pool.ts), so the symbol is guaranteed in
        // scope. typeof guard handles the impossible case of a preamble
        // pre-dating WASI socket and polling support (defensive only).
        const runStartAsync = typeof __wasiRunStartAsync === 'function'
            ? __wasiRunStartAsync
            : null;
        const initFS = __wasiInitFS;
        if (!mk || !runStart || !initFS) {
            return {
                ok: false,
                mode: 'wasi',
                error: 'WASI preamble missing: __wasi* helpers not defined. ' +
                    'Pool preamble may have failed to load.',
            };
        }
        // Install the preopens. fd 3 = the user's session root preopen. The
        // shim's fd table is reset by initFS each call.
        if (args.wasiFs) {
            // With its credential the process answers what it can from its own
            // store and sends its changes as waves (wasi/resident-filesystem.ts);
            // without, every call is a round trip to the session.
            initFS({ root: args.wasiFs.root, preopens: args.wasiFs.preopens, pid: args.processPid, cred: args.wasiFs.cred });
            // initFS resets the live state, so adoption has to follow it. Every
            // file the guest touches is then read from and written to the
            // authority through the stub.
            __wasiAdoptSupervisor(facetEnv && facetEnv.SUPERVISOR);
        }
        else {
            // initFS is what RESETS per-call state: the fd table and the preopen
            // list. A pooled isolate that skipped it would hand this program the
            // previous one's descriptors.
            initFS({ root: '', preopens: [] });
        }
        const memRef: {
            mem: WebAssembly.Memory | null;
        } = { mem: null };
        const abi = args.wasiAbi || 'preview1';
        const sup = facetEnv?.SUPERVISOR as {
            cpReadStdin?(pid: number, waitMs: number, acquire?: unknown, maxBytes?: number): Promise<{
                data: Uint8Array;
                ended: boolean;
                signal?: string;
            }>;
            stdout?: unknown;
        } | undefined;
        if (typeof sup?.stdout !== 'function')
            return { ok: false, mode: 'wasi', error: 'WASI process output capability is missing' };
        const live = __wasiSupervisorOutput(sup);
        const wasi = mk({
            argv: args.wasiArgv || [],
            env: args.wasiEnv || {},
            abi,
            threads: !!args.threads,
            stdoutBytes: live.stdoutBytes, stderrBytes: live.stderrBytes,
            ...(typeof sup?.cpReadStdin === 'function' ? { stdinRead: (maxBytes: number) => sup.cpReadStdin!(args.processPid!, 8000, undefined, maxBytes) } : {}),
            // Non-null by ordering, not by check. The import table is only ever
            // CALLED from inside the guest, and the guest cannot run before
            // `_start` below, by which point memRef.mem is assigned or the call
            // has already returned an error. The shim dereferences the result
            // unguarded, so if the ordering ever stops holding, the failure is a
            // TypeError raised inside a suspended syscall.
            getMemory: () => memRef.mem as WebAssembly.Memory,
        });
        // Bind ONLY the namespace this module actually imports, with the
        // import table built for that ABI. Aliasing one preview1 table onto
        // both names — which this did until the encodings were checked
        // against the binaries — gives a preview0 guest inverted fd_seek
        // whence and a 64-byte filestat it decodes as 56, so every lseek
        // lands wrong and every st_size reads back as the nlink field. The
        // signatures are identical, so nothing traps and nothing is logged.
        // The one place the precise table meets WebAssembly's own types, which
        // describe an import object as an untyped index signature. Widening
        // here keeps the precision on the shim's side of the boundary.
        const importObject: Record<string, WebAssembly.ModuleImports> = {
            nimbus_proc: wasi.procImport as unknown as WebAssembly.ModuleImports,
            nimbus_fs: wasi.fsImport as unknown as WebAssembly.ModuleImports,
            [args.wasiNamespace || 'wasi_snapshot_preview1']: wasi.wasiImport as unknown as WebAssembly.ModuleImports,
        };
        // A threads build imports its memory instead of defining one, because
        // every thread is another instance and they must all address the same
        // bytes. The host creates it — shared, at the module's declared limits
        // — and the scheduler, the syscall layer and each thread instance all
        // read through this one object.
        let sched: WasiThreadScheduler | null = null;
        if (args.threads) {
            let shared: WebAssembly.Memory;
            try {
                shared = new WebAssembly.Memory({
                    initial: args.threads.memory.initial,
                    maximum: args.threads.memory.maximum,
                    shared: true,
                });
            }
            catch (e) {
                // A shared memory reserves its MAXIMUM up front, so an over-large
                // --max-memory fails here rather than when the program grows into
                // it. Say which number did it; the alternative message is a bare
                // RangeError with no link to the build line that chose it.
                return {
                    ok: false,
                    mode: 'wasi',
                    error: `wasi-threads: could not reserve the shared memory the module declares `
                        + `(${args.threads.memory.initial}–${args.threads.memory.maximum} pages, `
                        + `${(args.threads.memory.maximum * 64) / 1024} MiB): ${errorText(e)}. `
                        + 'A shared memory reserves its maximum immediately — lower --max-memory.',
                };
            }
            memRef.mem = shared;
            importObject[args.threads.memory.module] = {
                ...(importObject[args.threads.memory.module] || {}),
                [args.threads.memory.name]: shared,
            };
            sched = __wasiThreadsCreate({
                memory: shared,
                startThread: __wasiThreadsStarter(mod, importObject),
            });
            Object.assign(importObject, sched.hostImports());
        }
        let inst: WebAssembly.Instance;
        try {
            const result = await WebAssembly.instantiate(mod, importObject) as WasmInstantiateResult;
            inst = (result instanceof WebAssembly.Instance ? result : result.instance);
        }
        catch (e) {
            return {
                ok: false,
                mode: 'wasi',
                error: `instantiate failed: ${errorText(e)}`,
            };
        }
        if (!memRef.mem) {
            const exported = inst.exports.memory;
            if (exported instanceof WebAssembly.Memory)
                memRef.mem = exported;
        }
        if (!memRef.mem) {
            return {
                ok: false,
                mode: 'wasi',
                error: 'wasm module did not export a `memory` — WASI requires one.',
            };
        }
        // WASI socket and polling support P3: use async runStart when available so any
        // suspending socket imports can complete via JSPI. The async
        // wrapper falls back to sync invocation internally when
        // WebAssembly.promising isn't available, so this is safe for
        // non-suspending programs too. Legacy preambles (pre-WASI socket and polling support)
        // that ship without __wasiRunStartAsync still work via the
        // sync runStart path.
        const r = sched
            ? await __wasiRunStartThreads(inst, sched)
            : runStartAsync
                ? await runStartAsync(inst, { memory: memRef.mem })
                : runStart(inst, { memory: memRef.mem });
        const lost = await live?.drain();
        wasi.procDispose();
        return {
            ok: r.exitCode === 0 && !r.error && !lost,
            mode: 'wasi',
            streamedOutput: live !== null,
            stdout: '',
            stderr: '',
            exitCode: lost && r.exitCode === 0 ? 1 : r.exitCode,
            exports: Object.keys(inst.exports),
            error: r.error ?? lost ?? undefined,
            // Its filesystem calls and who answered them (ResidentFilesystemStats).
            fsStats: typeof __wasiFsStats === 'function' ? __wasiFsStats() : null,
        };
    }
    // ── Direct mode ──
    let inst: WebAssembly.Instance;
    try {
        // Single-arg instantiate against a precompiled Module — this
        // is the form workerd's CSP DOES allow. The dynamic-bytes
        // form (instantiate(ArrayBuffer)) is what's blocked.
        const result = await WebAssembly.instantiate(mod, {}) as WasmInstantiateResult;
        inst = (result instanceof WebAssembly.Instance ? result : result.instance);
    }
    catch (e) {
        return {
            ok: false,
            mode: 'direct',
            error: `instantiate failed: ${errorText(e)}`,
        };
    }
    const exportNames = Object.keys(inst.exports);
    const fn = inst.exports[args.exportName!];
    if (typeof fn !== 'function') {
        return {
            ok: false,
            mode: 'direct',
            exports: exportNames,
            error: `export '${args.exportName}' is not a function (or not exported). ` +
                `Available exports: ${exportNames.join(', ')}`,
        };
    }
    let out: number | bigint | undefined;
    try {
        out = (fn as WasmDirectExport)(...(args.intArgs || []));
    }
    catch (e) {
        return {
            ok: false,
            mode: 'direct',
            exports: exportNames,
            error: `${args.exportName}(${(args.intArgs || []).join(', ')}) threw: ${errorText(e)}`,
        };
    }
    // BigInt (i64) → string; everything else → as-is.
    if (typeof out === 'bigint')
        return { ok: true, mode: 'direct', result: out.toString(), exports: exportNames };
    return { ok: true, mode: 'direct', result: out, exports: exportNames };
};
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
type WasmInstantiateResult = WebAssembly.Instance | {
    instance: WebAssembly.Instance;
    module: WebAssembly.Module;
};
