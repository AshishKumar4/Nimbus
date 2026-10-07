import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { generateTransformFacetRuntimeSource, transformSlices, } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { beginHelperFetch } from '@nimbus-sh/fabric/budgets.js';
import { applyFacetLimits, facetLimits, facetLoaderKey } from '@nimbus-sh/fabric/facet-limits.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import { classifyDoCall } from '@nimbus-sh/platform/oom-classify.js';
import { OXC_WASM_BUILD_ID } from '../oxc-wasm-artifact.generated.js';
import { OXC_FACET_BUILD_ID } from '../oxc-facet-artifact.generated.js';
import { fetchOxcFacetRuntime, fetchOxcWasmBytes } from '../runtime/oxc-wasm-bytes.js';
/**
 * The Oxc wasm's linear memory past which the facet drops its instance after
 * a call. The module starts at 4.25 MiB and a call grows it to the module's
 * working set, about 17 times a minified source (62 MiB for pi's 3.6 MiB
 * chunk; a 256 KiB transform slice stays near 10 MiB). Memory never shrinks,
 * so an instance a large module grew is released, and the next call starts
 * a fresh one in about a millisecond.
 */
const TRANSFORM_OXC_HIGH_WATER_BYTES = 32 * 1024 * 1024;
/**
 * Everything of the facet's module but its staged parts. `oxcWasm` is the
 * module map's compiled wasm, and the staged runtime (core
 * runtime/oxc-facet/preamble.ts) installs the wasm's driver, the
 * dynamic-import rewrite and the top-level-await lowering as globals.
 * Requests run one at a time on one instance, each answered or refused on
 * its own: a module Oxc rejects (or that crashes the instance, which is then
 * replaced) is a verdict on that module, never on its slice.
 */
const OXC_FACET_BODY = [
    generateTransformFacetRuntimeSource(),
    `const oxc = globalThis.__nimbusCreateOxcTransform(oxcWasm, { retireAboveBytes: ${TRANSFORM_OXC_HIGH_WATER_BYTES} });`,
    'export class OxcFacet extends DurableObject {',
    '  async transformMany(requests) {',
    '    const outcomes = [];',
    '    for (const { code, options } of requests) {',
    '      try {',
    '        outcomes.push(await runTransformRequest(oxc, code, options, globalThis.__nimbusRewriteDynamicImports, globalThis.__nimbusLowerAsyncModule));',
    '      } catch (e) {',
    '        const error = String((e && e.message) || e);',
    '        outcomes.push(e && e.stackExhausted === true ? { error, stackExhausted: true } : { error });',
    '      }',
    '    }',
    '    return outcomes;',
    '  }',
    '}',
].join('\n');
// The loader serves the code it cached under an id, so the id carries the code.
export const OXC_FACET_WORKER_ID = facetLoaderKey('transform', `nimbus-oxc:${OXC_WASM_BUILD_ID}:${OXC_FACET_BUILD_ID}:${hashSource(OXC_FACET_BODY)}`);
/**
 * Slim Worker Loader module whose DO class owns the Oxc wasm. `wasm` is the
 * staged module's verified bytes, compiled by the loader at startup; `runtime`
 * is the facet's staged runtime script.
 */
export function oxcFacetWorkerCode(wasm, runtime) {
    const source = [
        'import { DurableObject } from "cloudflare:workers";',
        'import oxcWasm from "oxc.wasm";',
        runtime,
        OXC_FACET_BODY,
    ].join('\n');
    return {
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
        mainModule: 'worker.js',
        modules: {
            'worker.js': source,
            'oxc.wasm': { wasm },
        },
        globalOutbound: null,
    };
}
/**
 * A Durable Object's transform facet: one loader-backed child that owns the
 * Oxc wasm, so the object's own isolate never instantiates it. Needs
 * `env.LOADER`, `env.ASSETS` and `ctx.facets`, and nothing of any host.
 */
async function oxcFacet(ctx, env) {
    const loader = Reflect.get(Object(env), 'LOADER');
    if (!loader || typeof loader.get !== 'function')
        throw new Error('Nimbus: env.LOADER unavailable for the transform facet');
    const assets = Reflect.get(Object(env), 'ASSETS');
    if (!assets || typeof assets.fetch !== 'function')
        throw new Error('Nimbus: env.ASSETS unavailable for the transform facet');
    const worker = await loader.get(OXC_FACET_WORKER_ID, async () => {
        const assetsEnv = { ASSETS: assets };
        const [wasm, runtime] = await Promise.all([fetchOxcWasmBytes(assetsEnv), fetchOxcFacetRuntime(assetsEnv)]);
        return applyFacetLimits('transform', oxcFacetWorkerCode(wasm, runtime));
    });
    const facetClass = worker.getDurableObjectClass('OxcFacet', { limits: facetLimits('transform') });
    return ctx.facets.get(OXC_FACET_WORKER_ID, async () => ({ class: facetClass }));
}
/**
 * One stub per Durable Object: a caller that starts while another is still
 * loading the facet waits on that load. A load or call that failed drops the
 * entry; the next caller mints a fresh stub.
 */
const sharedFacets = new WeakMap();
function sharedOxcFacet(ctx, env) {
    const current = sharedFacets.get(ctx);
    if (current)
        return current;
    const minted = oxcFacet(ctx, env);
    sharedFacets.set(ctx, minted);
    minted.catch(() => forgetOxcFacet(ctx, minted));
    return minted;
}
function forgetOxcFacet(ctx, stub) {
    if (sharedFacets.get(ctx) === stub)
        sharedFacets.delete(ctx);
}
/** Modules one stack-fallback call carries; a batch with more makes more calls. */
const STACK_FALLBACK_MODULES = 4;
/** How long one stack-fallback call may take before its modules' answers are transient. */
const STACK_FALLBACK_DEADLINE_MS = 30_000;
/** `call`, or a rejection once `ms` pass first. */
async function withDeadline(call, ms) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([call, deadline]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Calls per slice: a slice whose call failed is sent once more. */
const SLICE_ATTEMPTS = 2;
/**
 * The transform host a Durable Object's transforms run on: its transform
 * facet, a slice per call. Transforms are pure, so a slice whose call failed
 * (the facet reset, the connection dropped) is sent once more, to a freshly
 * minted stub; an overloaded facet is not asked again. A slice that still
 * fails answers each of its requests with a transient error, which is no
 * verdict on the source, and the other slices keep their answers.
 *
 * A module whose outcome says Oxc ran out of native stack on it
 * (`stackExhausted`, set by the driver from the RangeError, never read off
 * message text) goes to `stackFallback`, the esbuild facet in production:
 * every such module, in calls of at most STACK_FALLBACK_MODULES, each with a
 * deadline, each module logged. Its answer stands; the modules of a call that
 * fails or misses its deadline answer transient. Without a fallback the
 * exhaustion stands.
 */
export function oxcTransformHost(ctx, env, stackFallback, { fallbackDeadlineMs = STACK_FALLBACK_DEADLINE_MS } = {}) {
    return async (requests) => {
        let facet = null;
        const outcomes = [];
        // The facet's worker is in flight for the whole batch, bracketed rather
        // than wrapped (see beginLoaderFetch). Admitted on the ledger: the
        // launch's own worker when a launch's preparation transforms, else its
        // turn (beginHelperFetch).
        const endFetch = await beginHelperFetch(ctx, OXC_FACET_WORKER_ID);
        try {
            for (const slice of transformSlices(requests, (request) => request.code.length)) {
                let answered = null;
                let failure = null;
                for (let attempt = 1; answered === null && attempt <= SLICE_ATTEMPTS; attempt++) {
                    try {
                        facet ??= sharedOxcFacet(ctx, env);
                        answered = await (await facet).transformMany(slice);
                    }
                    catch (error) {
                        // A stub that threw may be broken for good; the next call mints its own.
                        if (facet)
                            forgetOxcFacet(ctx, facet);
                        facet = null;
                        failure = error;
                        if (classifyDoCall(error) === 'overloaded')
                            break;
                    }
                }
                if (answered === null) {
                    const error = `transform facet unavailable: ${errorText(failure)}`;
                    answered = slice.map(() => ({ error, transient: true }));
                }
                for (const outcome of answered)
                    outcomes.push(outcome);
            }
        }
        finally {
            endFetch();
        }
        if (stackFallback) {
            // Every module answered here: some callers (a prefetch bundle) have no
            // store or pacer that would send a deferred one again.
            const exhausted = outcomes.flatMap((outcome, index) => ('stackExhausted' in outcome && outcome.stackExhausted === true ? [index] : []));
            for (let at = 0; at < exhausted.length; at += STACK_FALLBACK_MODULES) {
                const group = exhausted.slice(at, at + STACK_FALLBACK_MODULES);
                for (const index of group) {
                    const reason = 'error' in outcomes[index] ? outcomes[index].error.split('\n').at(-1) : '';
                    console.warn(`[oxc-transform] ${requests[index].options?.dynamicImportParent ?? '<unnamed module>'}: ${reason}; transforming it with esbuild`);
                }
                const answered = await withDeadline(stackFallback(group.map((index) => requests[index])), fallbackDeadlineMs).catch((error) => group.map(() => ({ error: `esbuild facet unavailable: ${errorText(error)}`, transient: true })));
                group.forEach((index, i) => { outcomes[index] = answered[i]; });
            }
        }
        return outcomes;
    };
}
