/** Guest entries compiled independently of the host's runtime/bootstrap modules. */
import { errorText } from '../_shared/error-text.js';
import { errnoCodeOf, errnoOf, isVfsErrorCode, VFS_STRERROR } from '../vfs/vfs-error.js';
/** The step the classic submit transport carries: args object in, slice out.
 *  Serialized verbatim into the facet — every name it touches must be
 *  reachable there (globals or its own literals). */
export async function bashFacetStep(args, bindings) {
    const step = Reflect.get(globalThis, '__bashStep');
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
export async function bashRequestStep(request, bindings) {
    const step = Reflect.get(globalThis, '__bashStep');
    if (typeof step !== 'function') {
        return Response.json({
            state: 'error',
            exitCode: 127,
            stdout: '',
            stderr: '',
            error: 'bash-runner preamble missing (__bashStep not in scope)',
        });
    }
    // A body that does not parse is marked for the entry to name (TASK_BODY_FAILED).
    const args = await request.json().catch((error) => {
        if (error instanceof Error)
            Reflect.set(error, 'nimbusTaskBodyFailed', true);
        throw error;
    });
    return Response.json(await step(args, bindings.SUPERVISOR));
}
/**
 * Facet-side entry, compiled as a task expression at build time. The
 * interpreter is installed on globalThis by the facet's preamble.
 */
export async function cpythonRunFacetFn(args, facetEnv) {
    const run = Reflect.get(globalThis, '__cpythonRun');
    if (typeof run !== 'function') {
        return {
            stdout: '', stderr: '', exitCode: 127,
            error: 'cpython preamble missing: __cpythonRun not in scope',
        };
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor');
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where the boot re-adopts it after the mount: adopting only here
    // would be undone by __wasiInitFS, which clears it on purpose.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
    adopt?.(supervisor);
    return run(args);
}
export const clangFacetCall = async function clangFacetCall(inArgs, facetEnv) {
    const wasm = Reflect.get(globalThis, '__NIMBUS_WASM');
    const primaryMod = wasm?.['primary.wasm'];
    if (!primaryMod) {
        return {
            exitCode: 127, stdout: '', stderr: '',
            error: 'clang-runner: __NIMBUS_WASM missing primary.wasm',
        };
    }
    const fn = Reflect.get(globalThis, '__clangRun');
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
export const rubyFacetCall = async function rubyFacetCall(inArgs, facetEnv) {
    const fn = Reflect.get(globalThis, '__rubyRunProcess');
    if (typeof fn !== 'function') {
        return { exitCode: 127, stdout: '', stderr: '',
            error: 'ruby-runner preamble missing: __rubyRunProcess not in scope' };
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor');
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where the run re-adopts it after the mount; adopting only
    // here would be undone by __wasiInitFS.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusRubySupervisor', supervisor);
    adopt?.(supervisor);
    // The invocation as the runner made it: a field it adds reaches the VM.
    const answer = await fn(inArgs);
    // Experiment (not for landing): the run's filesystem statistics.
    return typeof answer === 'object' && answer !== null ? { ...answer, fsStats: typeof __wasiFsStats === 'function' ? __wasiFsStats() : null } : answer;
};
export const wasmFacetCall = async function wasmFacetCall(args, facetEnv) {
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
        const memRef = { mem: null };
        const abi = args.wasiAbi || 'preview1';
        const sup = facetEnv?.SUPERVISOR;
        if (typeof sup?.stdout !== 'function')
            return { ok: false, mode: 'wasi', error: 'WASI process output capability is missing' };
        const live = __wasiSupervisorOutput(sup);
        const wasi = mk({
            argv: args.wasiArgv || [],
            env: args.wasiEnv || {},
            abi,
            threads: !!args.threads,
            stdoutBytes: live.stdoutBytes, stderrBytes: live.stderrBytes,
            // Non-null by ordering, not by check. The import table is only ever
            // CALLED from inside the guest, and the guest cannot run before
            // `_start` below, by which point memRef.mem is assigned or the call
            // has already returned an error. The shim dereferences the result
            // unguarded, so if the ordering ever stops holding, the failure is a
            // TypeError raised inside a suspended syscall.
            getMemory: () => memRef.mem,
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
        const importObject = {
            nimbus_proc: wasi.procImport,
            nimbus_fs: wasi.fsImport,
            [args.wasiNamespace || 'wasi_snapshot_preview1']: wasi.wasiImport,
        };
        // A threads build imports its memory instead of defining one, because
        // every thread is another instance and they must all address the same
        // bytes. The host creates it — shared, at the module's declared limits
        // — and the scheduler, the syscall layer and each thread instance all
        // read through this one object.
        let sched = null;
        if (args.threads) {
            let shared;
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
        let inst;
        try {
            const result = await WebAssembly.instantiate(mod, importObject);
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
    let inst;
    try {
        // Single-arg instantiate against a precompiled Module — this
        // is the form workerd's CSP DOES allow. The dynamic-bytes
        // form (instantiate(ArrayBuffer)) is what's blocked.
        const result = await WebAssembly.instantiate(mod, {});
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
    const fn = inst.exports[args.exportName];
    if (typeof fn !== 'function') {
        return {
            ok: false,
            mode: 'direct',
            exports: exportNames,
            error: `export '${args.exportName}' is not a function (or not exported). ` +
                `Available exports: ${exportNames.join(', ')}`,
        };
    }
    let out;
    try {
        out = fn(...(args.intArgs || []));
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
/** tsrs's own status for a run that crashed (a panic, or a trap: a stack overflow, running out of memory); tsc's are 0-4. */
const TSRS_EXIT_CRASHED = 5;
/** Text a failure is reported to tsrs as: Rust's io::Error display, "<strerror> (os error N)", as @tsrs/wasm's Node host gives it. */
function tsrsErrorText(error) {
    const code = errnoCodeOf(error);
    const errno = code === undefined ? undefined : errnoOf(code);
    return isVfsErrorCode(code) && errno !== undefined ? `${VFS_STRERROR[code]} (os error ${-errno})` : errorText(error);
}
function tsrsMissing(error) {
    return errnoCodeOf(error) === 'ENOENT';
}
/** A directory entry's kind as tsrs reads it: d, f, l (a link, which it stats next), or o. */
function tsrsKind(type) {
    return type === 'directory' ? 'd' : type === 'file' ? 'f' : type === 'symlink' ? 'l' : 'o';
}
/**
 * One of tsrs's file operations (its `tsrs_host.fs` import, @tsrs/wasm's
 * core.js), answered from `fs`: the bytes to hand back, or null for a path
 * that does not exist. `request` is the operation's path, and for a write
 * the path, a NUL and the bytes; the times of a chtimes follow its path the
 * same way, as two NUL-separated decimal nanosecond counts.
 */
export async function tsrsFileOperation(fs, op, request) {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const nul = request.indexOf(0);
    const path = decoder.decode(nul < 0 ? request : request.subarray(0, nul));
    const rest = nul < 0 ? new Uint8Array(0) : request.subarray(nul + 1);
    try {
        switch (op) {
            case 0: return await fs.readFile(path);
            case 1: {
                const stat = await fs.stat(path);
                return stat === null ? null : `${tsrsKind(stat.type)} ${stat.size} ${BigInt(Math.round(stat.mtime * 1e6))}`;
            }
            case 2: {
                const entries = await fs.readdir(path);
                const kinds = [];
                for (const entry of entries) {
                    // A backend that cannot tell an entry's type without a stat (DT_UNKNOWN) is asked for it.
                    let kind = tsrsKind(entry.type);
                    if (entry.type === 'unknown') {
                        const stat = await fs.stat(`${path.replace(/\/+$/, '')}/${entry.name}`, { followSymlinks: false });
                        if (stat !== null)
                            kind = tsrsKind(stat.type);
                    }
                    kinds.push(`${kind}${entry.name}\0`);
                }
                return kinds.join('');
            }
            case 3: return await fs.realpath(path);
            // A write makes the directories it lands in, as tsrs's own host's do.
            case 4: {
                await fs.writeFile(path, rest.slice(), { createParents: true });
                return '';
            }
            case 5: {
                const stat = await fs.stat(path);
                await fs.writeRange(path, stat?.size ?? 0, rest.slice(), { createParents: true });
                return '';
            }
            case 6: {
                await fs.remove(path, { recursive: true, force: true });
                return '';
            }
            case 7: {
                const [atime, mtime] = decoder.decode(rest).split('\0').map((ns) => Number(BigInt(ns)) / 1e6);
                await fs.utimes(path, atime, mtime);
                return '';
            }
            default: throw new Error(`unknown file operation ${op}`);
        }
    }
    catch (error) {
        if (tsrsMissing(error))
            return null;
        throw error;
    }
}
/**
 * Runs in the facet: one tsc invocation of tsrs.wasm (@tsrs/wasm), a fresh
 * instance, the module's own `tsrs_input` / `tsrs_run` protocol. Its files
 * are the process's resident filesystem (wasi/resident-filesystem.ts), so
 * tsrs is a WASI guest like any other: the store answers what it holds, a
 * miss asks the session, and what it writes settles before its exit status.
 * The module calls its file import synchronously; the import suspends the
 * run (JSPI) while the filesystem answers.
 */
export async function tsrsFacetCall(args, facetEnv) {
    const module = Reflect.get(globalThis, '__NIMBUS_WASM')?.['tsrs.wasm'];
    if (!(module instanceof WebAssembly.Module))
        return { exitCode: 127, error: 'tsrs: the facet has no tsrs.wasm' };
    if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
        return { exitCode: 1, error: 'tsrs: this host cannot suspend a WebAssembly call, and tsrs waits on every file it reads' };
    }
    // Its own files and descriptors, none of the last process's (initFS
    // resets them), then the call's capability. No preopens, as upstream:
    // tsrs reaches files through its own import only.
    __wasiInitFS({ root: '', preopens: [], cred: args.cred, pid: args.processPid });
    __wasiAdoptSupervisor(facetEnv?.SUPERVISOR ?? null);
    const fs = __wasiFilesystem('jspi');
    if (fs === null)
        return { exitCode: 1, error: 'tsrs: the facet was opened without a filesystem' };
    const output = __wasiSupervisorOutput(facetEnv?.SUPERVISOR);
    let memory = null;
    const wasi = __wasiMakeImports({
        argv: [], env: args.env,
        getMemory: () => memory,
        stdoutBytes: output.stdoutBytes, stderrBytes: output.stderrBytes,
    });
    let staged = new Uint8Array(0);
    const encoder = new TextEncoder();
    const stage = (answer) => {
        staged = typeof answer === 'string' ? encoder.encode(answer) : answer;
        return staged.length;
    };
    // The operation's bytes are copied before the first await: the module's
    // memory may grow while the filesystem answers, which detaches the view.
    const fileOperation = async (op, ptr, len) => {
        const request = new Uint8Array(memory.buffer, ptr, len).slice();
        try {
            const answer = await tsrsFileOperation(fs, op, request);
            return answer === null ? -1 : stage(answer);
        }
        catch (error) {
            return -2 - stage(tsrsErrorText(error));
        }
    };
    const importObject = {
        tsrs_host: {
            fs: new WebAssembly.Suspending(fileOperation),
            fs_take: (ptr) => { new Uint8Array(memory.buffer).set(staged, ptr); },
        },
        wasi_snapshot_preview1: wasi.wasiImport,
    };
    let instance;
    try {
        instance = await WebAssembly.instantiate(module, importObject);
    }
    catch (error) {
        return { exitCode: 1, error: `tsrs: instantiate failed: ${errorText(error)}` };
    }
    memory = instance.exports.memory;
    const exports = instance.exports;
    let exitCode = 0;
    let crashed = false;
    try {
        // Every entry goes through promising: an import any of them reaches may suspend.
        if (typeof exports._initialize === 'function')
            await WebAssembly.promising(exports._initialize)();
        const request = encoder.encode([args.cwd, '0', ...args.argv].join('\0'));
        const at = await WebAssembly.promising(exports.tsrs_input)(request.length);
        new Uint8Array(memory.buffer).set(request, at);
        exitCode = await WebAssembly.promising(exports.tsrs_run)();
    }
    catch (error) {
        if (error && error.constructor && error.constructor.name === '__WasiExit') {
            exitCode = error.code;
        }
        else if (error instanceof WebAssembly.RuntimeError || (error instanceof RangeError && /call stack/i.test(error.message))) {
            // As @tsrs/wasm's own host reports a trap: a stack overflow or running out of memory.
            crashed = true;
            exitCode = TSRS_EXIT_CRASHED;
            await output.stderrBytes(encoder.encode(`error: tsrs.wasm trapped (${error.name}: ${error.message}); a stack overflow on deeply nested code or running out of memory are the usual causes\n`));
        }
        else {
            throw error;
        }
    }
    // What it wrote is in the session before its status is: a write the
    // session refused fails the run, named (__wasiSettled).
    const settled = await __wasiSettled({ exitCode });
    const lost = await output.drain();
    wasi.procDispose();
    return {
        exitCode: lost && settled.exitCode === 0 ? 1 : settled.exitCode,
        ...(settled.error || lost ? { error: settled.error ?? lost ?? undefined } : {}),
        memoryBytes: memory.buffer.byteLength,
        fsStats: typeof __wasiFsStats === 'function' ? __wasiFsStats() : null,
        reusable: !lost && !crashed && __wasiReusable(),
    };
}
