import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { beginHelperFetch } from '@nimbus-sh/fabric/budgets.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import { loadHelperFacet } from './helper-facet.js';
import { ROLLDOWN_FACET_ASSET_PATH, ROLLDOWN_FACET_BUILD_ID, ROLLDOWN_FACET_SHA256 } from '../rolldown-facet-artifact.generated.js';
import { fetchStagedText, stagedAsset } from '../runtime/staged-source.js';
import { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, fetchStagedBindingAsset, stagedBinding, } from '../runtime/staged-bindings.js';
const ROLLDOWN = stagedBinding('rolldown');
/**
 * The binding's linear memory past which the facet asks to be retired after
 * a call. It starts at 5.4 MiB and grows to the largest graph built, and never
 * shrinks; pre-bundles measured 17.6 MiB after react-dom/client, 27.9 after
 * framer-motion, 53.8 after recharts and 60.5 after @mui/material (slices of
 * up to 23 MiB). A call peaks at the binding it starts on, plus what it grows
 * the binding by, plus its slice, plus the isolate's JavaScript: Markflow's
 * install, deployed, grew the binding by up to 41 MiB in one pre-bundle
 * (rehype-highlight, 27 -> 68 MiB; react-day-picker, 14 -> 51 MiB with a
 * 17.6 MiB slice), and the facet's JavaScript holds 12-18 MiB between calls
 * (V8, the staged runtime). A call starting at 64 MiB could pass the
 * isolate's 128 MiB; at 40 MiB the worst measured is about 112 MiB.
 */
const BUILD_BINDING_HIGH_WATER_BYTES = 40 * 1024 * 1024;
/**
 * Everything of the build facet's module but its staged parts: the napi-rs
 * wasm loader (scripts/napi-wasm/loader), the threadless rolldown binding and
 * its wasi trampoline, and the facet's runtime (scripts/rolldown-facet: rolldown's
 * JavaScript and core's esbuild-contract adapter, runtime/rolldown-build.ts).
 * The binding is instantiated by the first build and kept: its linear memory
 * starts at the binding's declared minimum and grows with the largest module
 * graph built. Nothing here reads a file: every module comes from the
 * caller's plugin, so the binding's WASI filesystem is the facet's own empty
 * node:fs.
 *
 * The binding is the isolate's: every Durable Object whose build facet runs
 * this code in this isolate (one loader id for all of them) calls the one
 * binding, and each may do I/O only in its own context. So each call runs in
 * a lane of its own (napi-wasm-loader's callLanes): the binding's calls into
 * JavaScript (a plugin hook, through a threadsafe function) run in the lane
 * of the call that made the function, and its pump in the lanes of the calls
 * in flight, never in another object's. A call whose object is reset under
 * it never settles, and neither does what the binding awaits for it: the
 * first call of the object's next instance of this facet takes its lanes
 * over, and the binding refuses those awaits, so the build ends and its
 * state is freed.
 *
 * A binding that dies (a trap, or the stack overflowing inside it: a module
 * nested too deeply) holds promises that never settle. The loader says so
 * (`onFatal`), and every build or pre-bundle on it, in flight or later, is
 * answered at once with `crashed`; rolldown's JavaScript keeps the binding it
 * imported, so only a fresh isolate (the host's next generation) builds again.
 */
const BUILD_FACET_BODY = [
    'const lanes = callLanes(AsyncLocalStorage);',
    // One load for every caller, overlapping ones included.
    'let runtime = null;',
    'let crashed = null;',
    'const inFlight = new Set();',
    'let memory = null;',
    'function rolldownRuntime() {',
    '  if (runtime === null) {',
    `    memory = new WebAssembly.Memory({ initial: ${ROLLDOWN.memoryPages}, maximum: 65536 });`,
    '    globalThis.__nimbusRolldownBinding = createNapiWasmBinding({',
    '      fs, env: {}, writeStdout() {}, writeStderr() {},',
    `      binding: rolldownWasm, trampoline: trampolineWasm, memoryPages: ${ROLLDOWN.memoryPages}, memory, name: "rolldown", contexts: lanes,`,
    '      onFatal(error) {',
    '        crashed = { stackExhausted: error instanceof RangeError, message: String((error && error.message) || error) };',
    '        for (const answer of inFlight) answer();',
    '        inFlight.clear();',
    '      },',
    '    });',
    // Dynamic: rolldown's JavaScript reads the binding as it evaluates, so it is imported once the binding exists.
    '    runtime = import("rolldown-runtime.js");',
    '  }',
    '  return runtime;',
    '}',
    'function crashText() {',
    '  return crashed.stackExhausted',
    '    ? "Nimbus\'s bundler ran out of stack: a module nests too deeply for it (" + crashed.message + ")"',
    '    : "Nimbus\'s bundler crashed: " + crashed.message;',
    '}',
    // One call on the binding, in a lane of `calls`, answered by `crashedAnswer()`
    // if the binding is or becomes dead, and marked `retire` once the binding has
    // outgrown its mark. An abandoned call is answered by no one.
    'async function onBinding(calls, call, crashedAnswer) {',
    '  if (crashed) return crashedAnswer();',
    '  const loaded = await rolldownRuntime();',
    '  if (crashed) return crashedAnswer();',
    '  return new Promise((resolve, reject) => {',
    '    const answer = () => resolve(crashedAnswer());',
    '    inFlight.add(answer);',
    `    const outgrown = (value) => (memory.buffer.byteLength > ${BUILD_BINDING_HIGH_WATER_BYTES} ? { ...value, retire: true } : value);`,
    '    const done = () => inFlight.delete(answer);',
    '    calls.run(() => call(loaded), done).then((value) => resolve(outgrown(value)), reject).finally(done);',
    '  });',
    '}',
    'export class BuildFacet extends DurableObject {',
    // This facet's Durable Object has one instance at a time: a new one's
    // first call takes over every call the last one left on the binding.
    '  #calls;',
    '  constructor(ctx, env) {',
    '    super(ctx, env);',
    '    this.#calls = lanes.instance(ctx.id ? String(ctx.id) : undefined);',
    '  }',
    '  async warm() {',
    '    if (!crashed) await rolldownRuntime();',
    '  }',
    '  build(options, plugin) {',
    '    return onBinding(this.#calls, (loaded) => loaded.build(options, plugin), () => ({',
    '      outputFiles: [], warnings: [], failure: "Build failed with 1 error:\\nerror: " + crashText(),',
    '      errors: [{ id: "", pluginName: "", text: crashText(), location: null, notes: [], detail: undefined }],',
    '      crashed,',
    '    }));',
    '  }',
    '  prebundle(spec) {',
    '    return onBinding(this.#calls, (loaded) => loaded.prebundle(spec), () => ({',
    '      specifier: spec.specifier, ok: false, esmCode: "", errorText: crashText(), elapsed: 0, warnings: [], crashed,',
    '    }));',
    '  }',
    '}',
].join('\n');
// The loader serves the code it cached under an id, so the id carries the code.
export const BUILD_FACET_WORKER_ID = [
    'nimbus-build',
    `rolldown-${ROLLDOWN.version}-${ROLLDOWN.wasm.sha256.slice(0, 16)}`,
    NAPI_WASM_LOADER.sha256.slice(0, 16),
    NAPI_WASM_TRAMPOLINE.sha256.slice(0, 16),
    ROLLDOWN_FACET_BUILD_ID,
    hashSource(BUILD_FACET_BODY),
].join(':');
export async function fetchBuildFacetParts(env) {
    const [loader, trampoline, rolldown, runtime] = await Promise.all([
        fetchStagedBindingAsset(env, NAPI_WASM_LOADER).then((bytes) => new TextDecoder().decode(bytes)),
        fetchStagedBindingAsset(env, NAPI_WASM_TRAMPOLINE),
        fetchStagedBindingAsset(env, ROLLDOWN.wasm),
        fetchStagedText(env, stagedAsset({
            label: 'build facet runtime',
            path: ROLLDOWN_FACET_ASSET_PATH,
            l2Key: `https://nimbus-cache.invalid${ROLLDOWN_FACET_ASSET_PATH}`,
            sha256: ROLLDOWN_FACET_SHA256,
            contentType: 'text/javascript; charset=utf-8',
            requiredBy: 'the build facet',
            stagedBy: 'scripts/bundle-facet-workers.mjs',
        })),
    ]);
    return { loader, trampoline, rolldown, runtime };
}
/** The build facet's Worker Loader module: the class that owns rolldown, and its staged parts. */
export function buildFacetWorkerCode(parts) {
    const source = [
        'import { DurableObject } from "cloudflare:workers";',
        'import * as fs from "node:fs";',
        'import { AsyncLocalStorage } from "node:async_hooks";',
        'import { callLanes, createNapiWasmBinding } from "napi-wasm-loader.js";',
        'import rolldownWasm from "rolldown.wasm";',
        'import trampolineWasm from "trampoline.wasm";',
        BUILD_FACET_BODY,
    ].join('\n');
    return {
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
        mainModule: 'worker.js',
        modules: {
            'worker.js': source,
            'napi-wasm-loader.js': parts.loader,
            'rolldown-runtime.js': parts.runtime,
            'rolldown.wasm': { wasm: parts.rolldown },
            'trampoline.wasm': { wasm: parts.trampoline },
        },
        globalOutbound: null,
    };
}
/**
 * Which isolate of the build facet's code builds: a binding that died is
 * left behind with its isolate, and every Durable Object this isolate hosts
 * moves to the next generation's, whose loader id and facet name are new.
 */
let generation = 0;
const generationId = (n) => `${BUILD_FACET_WORKER_ID}:g${n}`;
/**
 * One stub per Durable Object: callers that overlap wait on one facet load.
 * A load or call that failed drops the entry; the next caller mints a fresh one.
 * An entry of a retired generation is dropped, and its facet aborted once
 * the calls still on it are answered.
 */
const sharedFacets = new WeakMap();
function sharedBuildFacet(ctx, env) {
    const current = sharedFacets.get(ctx);
    if (current && current.generation === generation)
        return current;
    if (current)
        retireFacet(ctx, current);
    const stub = loadHelperFacet(ctx, env, {
        id: generationId(generation),
        className: 'BuildFacet',
        what: 'the build facet',
        code: async (assets) => buildFacetWorkerCode(await fetchBuildFacetParts(assets)),
    });
    const minted = { generation, stub, calls: 0, retired: false, crashed: false };
    sharedFacets.set(ctx, minted);
    minted.stub.catch(() => forgetBuildFacet(ctx, minted));
    return minted;
}
function forgetBuildFacet(ctx, facet) {
    if (sharedFacets.get(ctx) === facet)
        sharedFacets.delete(ctx);
}
function retireFacet(ctx, facet) {
    forgetBuildFacet(ctx, facet);
    // Once: every answer on an outgrown binding says to retire it.
    if (facet.retired)
        return;
    facet.retired = true;
    if (facet.calls === 0)
        abortFacet(ctx, facet);
}
function abortFacet(ctx, facet) {
    try {
        ctx.facets.abort(generationId(facet.generation), new Error('Nimbus: the build facet was retired'));
    }
    catch {
        // already gone
    }
}
/**
 * A call on `facet` began: it is counted until it is answered, on the
 * Durable Object's Dynamic Worker ledger under its generation's own worker
 * id, since a retired generation's call and the next one's can be in flight
 * at once as two workers. It is admitted as a helper's call is
 * (beginHelperFetch): a launch's build or prebundle is the launch's own
 * worker, anything else waits its turn. Counted on the facet from the start,
 * so a retirement while it waits does not abort the facet under it.
 */
async function beginCall(ctx, facet) {
    facet.calls++;
    const endFetch = await beginHelperFetch(ctx, generationId(facet.generation));
    return () => {
        endFetch();
        facet.calls--;
        if (facet.retired && facet.calls === 0)
            abortFacet(ctx, facet);
    };
}
/**
 * Loads the Durable Object's build facet ahead of its first build: the staged
 * parts fetched and verified, the binding instantiated and rolldown's
 * JavaScript evaluated, which a fresh session's first build would otherwise
 * wait on (a 13 MiB binding), while `wrangler dev` reads its config. (A
 * warm-up as `vite build` starts measured no gain: that build's first
 * seconds go to resolving through the VFS plugin.) Best effort: a failed
 * warm-up only drops the stub, as a failed call does.
 */
export function prewarmBuildFacet(ctx, env) {
    // loadBuildFacet keeps the stub call a direct call awaited by the frame
    // that made it, as every facet call must (see beginLoaderFetch).
    loadBuildFacet(ctx, env).catch(() => { });
}
/**
 * The build host a Durable Object's builds run on: its build facet, which runs
 * rolldown. The plugin, and with it every file read, stays with the caller.
 *
 * A build whose binding died under it (`crashed`: a trap, or a module nested
 * past the stack) retires that generation: the next build mints a fresh
 * isolate. The build itself, and every other one that was in flight on that
 * binding, goes to `fallback` (the esbuild facet in production), each logged;
 * without one, its failure says what happened.
 */
export function rolldownBuildHost(ctx, env, fallback) {
    return async (options, plugin) => {
        const facet = sharedBuildFacet(ctx, env);
        const endCall = await beginCall(ctx, facet);
        let outcome;
        try {
            outcome = await (await facet.stub).build(options, plugin);
        }
        catch (error) {
            forgetBuildFacet(ctx, facet);
            if (!facet.crashed)
                throw error;
            // The binding died under this build too, and its answer did not make it back.
            outcome = { outputFiles: [], errors: [], warnings: [], crashed: { stackExhausted: false, message: error instanceof Error ? error.message : String(error) } };
        }
        finally {
            endCall();
        }
        const { crashed, retire, ...built } = outcome;
        if (retire)
            retireGeneration(ctx, facet);
        if (!crashed)
            return built;
        retireCrashed(ctx, facet);
        const entries = Array.isArray(options.entryPoints) ? options.entryPoints.join(', ') : '<entries>';
        console.warn(`[build-facet] rolldown's binding died building ${entries} (${crashed.message}); ${fallback ? 'building it with esbuild' : 'the build fails'}`);
        if (fallback)
            return fallback(options, plugin);
        if (built.failure)
            return built;
        const text = `Nimbus's bundler crashed: ${crashed.message}`;
        return { ...built, failure: `Build failed with 1 error:\nerror: ${text}`, errors: [{ id: '', pluginName: '', text, location: null, notes: [], detail: undefined }] };
    };
}
/**
 * Leaves a dead binding's generation behind: the next call on any Durable
 * Object mints the next. Its calls still in flight are answered (the facet
 * answers each one, crashed) before the facet is aborted.
 */
function retireCrashed(ctx, facet) {
    facet.crashed = true;
    retireGeneration(ctx, facet);
}
/** Moves every Durable Object this isolate hosts past `facet`'s generation, and retires it. */
function retireGeneration(ctx, facet) {
    if (facet.generation === generation)
        generation++;
    retireFacet(ctx, facet);
}
/** A pre-bundle whose build facet was reset under it twice: the call and its one retry. */
export class BuildFacetResetError extends Error {
    specifier;
    reason;
    constructor(specifier, reason) {
        super(`Nimbus's build facet was reset twice while pre-bundling ${specifier} (${reason})`);
        this.specifier = specifier;
        this.reason = reason;
        this.name = 'BuildFacetResetError';
    }
}
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
/**
 * Pre-bundles one npm specifier from its slice in the Durable Object's build
 * facet (core runtime/prebundle-slice.ts on rolldown): the slice crosses
 * once, with the call, and the bundle comes back. A failed pre-bundle is a
 * result (`ok: false`), as is one whose binding died under it, which also
 * retires that generation.
 *
 * A call that throws (the facet's isolate reset under it: past its memory,
 * or its host gone) drops the stub, and the pre-bundle, which is pure, runs
 * once more on a fresh facet, logged. A second throw is a
 * BuildFacetResetError naming the package and why; a facet that never
 * loaded is the load's own error, not retried.
 */
export function buildFacetPrebundler(ctx, env) {
    /** One call: its answer, or what it threw (`reset`: the call itself, on a loaded facet). */
    const once = async (spec) => {
        const facet = sharedBuildFacet(ctx, env);
        const endCall = await beginCall(ctx, facet);
        let result;
        try {
            const stub = await facet.stub;
            try {
                result = await stub.prebundle(spec);
            }
            catch (error) {
                forgetBuildFacet(ctx, facet);
                if (!facet.crashed)
                    throw Object.assign(new Error(messageOf(error)), { reset: true });
                const message = messageOf(error);
                result = { specifier: spec.specifier, ok: false, esmCode: '', errorText: `Nimbus's bundler crashed: ${message}`, elapsed: 0, warnings: [], crashed: { stackExhausted: false, message } };
            }
        }
        catch (error) {
            forgetBuildFacet(ctx, facet);
            throw error;
        }
        finally {
            endCall();
        }
        const { crashed, retire, ...answer } = result;
        if (retire)
            retireGeneration(ctx, facet);
        if (crashed) {
            retireCrashed(ctx, facet);
            console.warn(`[build-facet] rolldown's binding died pre-bundling ${spec.specifier} (${crashed.message})`);
        }
        return answer;
    };
    const wasReset = (error) => Reflect.get(Object(error), 'reset') === true;
    return async (spec) => {
        try {
            return await once(spec);
        }
        catch (error) {
            if (!wasReset(error))
                throw error;
            console.warn(`[build-facet] the build facet was reset pre-bundling ${spec.specifier} (${messageOf(error)}); pre-bundling it once more on a fresh one`);
        }
        try {
            return await once(spec);
        }
        catch (error) {
            if (!wasReset(error))
                throw error;
            console.warn(`[build-facet] the build facet was reset again pre-bundling ${spec.specifier} (${messageOf(error)}); giving up`);
            throw new BuildFacetResetError(spec.specifier, messageOf(error));
        }
    };
}
/**
 * Loads the Durable Object's build facet and waits for it: the staged parts
 * fetched and verified, the binding instantiated. What prewarmBuildFacet
 * starts, for a caller that wants the load behind it before it allocates
 * (a pre-bundle's slice). Rejects as the load does.
 */
export async function loadBuildFacet(ctx, env) {
    const facet = sharedBuildFacet(ctx, env);
    const endCall = await beginCall(ctx, facet);
    try {
        await (await facet.stub).warm();
    }
    catch (error) {
        forgetBuildFacet(ctx, facet);
        throw error;
    }
    finally {
        endCall();
    }
}
