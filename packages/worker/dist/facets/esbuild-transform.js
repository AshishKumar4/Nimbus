import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { EsbuildService, generateEsbuildFacetRuntimeSource, generateTransformFacetRuntimeSource, } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { beginHelperFetch } from '@nimbus-sh/fabric/budgets.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import { ESBUILD_WASM_VERSION } from '../esbuild-wasm-bundle.generated.js';
import { ESBUILD_CLI_BUILD_ID } from '../esbuild-cli-artifact.generated.js';
import { fetchEsbuildCliRunner, fetchEsbuildJsFnBody, fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';
import { OXC_FACET_BUILD_ID } from '../oxc-facet-artifact.generated.js';
import { fetchOxcFacetRuntime } from '../runtime/oxc-wasm-bytes.js';
import { OXC_FACET_WORKER_ID, oxcTransformHost } from './oxc-transform.js';
import { rolldownBuildHost } from './build-facet.js';
/**
 * Everything of the facet's module but its staged parts: esbuild's JS adapter,
 * which the wasm version keys, the `esbuild` command's runner, which its
 * build id keys, and the transform facet's runtime (the dynamic-import
 * rewrite and the top-level-await lowering), which its build id keys.
 * `wasmModule` and `newEsbuild` are bound by the lines before it; the runner
 * installs `globalThis.__esbuildCliRun`, the runtime its own globals.
 *
 * Transforms run in the transform facet (oxc-transform.ts); `transformMany`
 * here answers only the modules that ran it out of stack (oxcTransformHost).
 * Builds run in the build facet (build-facet.ts); `build` here answers only
 * those whose rolldown binding died under them (rolldownBuildHost). An
 * `esbuild` command, such a batch or such a build gets its own Go instance,
 * dropped when it ends.
 */
const ESBUILD_FACET_BODY = [
    ESBUILD_NAME_GLOBAL_SHIM,
    generateEsbuildFacetRuntimeSource(),
    generateTransformFacetRuntimeSource(),
    'export class EsbuildFacet extends DurableObject {',
    '  async transformMany(requests) {',
    '    const own = newEsbuild();',
    '    await own.initialize({ wasmModule, worker: false });',
    '    try {',
    '      const outcomes = [];',
    '      for (const { code, options } of requests) {',
    '        try {',
    '          outcomes.push(await runTransformRequest(own, code, options, globalThis.__nimbusRewriteDynamicImports, globalThis.__nimbusLowerAsyncModule));',
    '        } catch (e) {',
    '          outcomes.push({ error: String((e && e.message) || e) });',
    '        }',
    '      }',
    '      return outcomes;',
    '    } finally {',
    '      await own.stop();',
    '    }',
    '  }',
    '  async build(options, plugin) {',
    '    const own = newEsbuild();',
    '    await own.initialize({ wasmModule, worker: false });',
    '    try {',
    '      return await buildWithEsbuild(own, options, plugin);',
    '    } finally {',
    '      await own.stop();',
    '    }',
    '  }',
    '  async cli(args, supervisor, output) {',
    '    return globalThis.__esbuildCliRun(args, supervisor, output, wasmModule);',
    '  }',
    '}',
].join('\n');
// The loader serves the code it cached under an id, so the id carries the code.
export const ESBUILD_FACET_WORKER_ID = `nimbus-esbuild:${ESBUILD_WASM_VERSION}:${ESBUILD_CLI_BUILD_ID}:${OXC_FACET_BUILD_ID}:${hashSource(ESBUILD_FACET_BODY)}`;
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `wasm` is the staged esbuild.wasm (fetchEsbuildWasmBytes), compiled by the
 * facet's module map at its startup: no other isolate holds it.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), compiled into a
 * factory at startup, the one moment code may be generated from a string;
 * each call of the factory is a separate esbuild, and takes the `WebAssembly`
 * namespace its adapter instantiates through (`newEsbuild(webAssembly)`,
 * the global one unless given). `cliRunner` is the staged runner of the
 * `esbuild` command (fetchEsbuildCliRunner).
 */
export function esbuildFacetWorkerCode(wasm, jsFnBody, cliRunner, transformRuntime) {
    const source = [
        'import { DurableObject } from "cloudflare:workers";',
        'import wasmModule from "esbuild.wasm";',
        `const esbuildFactory = new Function("WebAssembly", ${JSON.stringify(jsFnBody)});`,
        'const newEsbuild = (webAssembly = WebAssembly) => esbuildFactory(webAssembly);',
        cliRunner,
        transformRuntime,
        ESBUILD_FACET_BODY,
    ].join('\n');
    return {
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
        mainModule: 'worker.js',
        modules: {
            'worker.js': source,
            'esbuild.wasm': { wasm },
        },
        globalOutbound: null,
    };
}
/**
 * A Durable Object's esbuild facet: one loader-backed child that owns the
 * esbuild wasm, so the object's own isolate never instantiates it. Needs
 * `env.LOADER`, `env.ASSETS` and `ctx.facets`, and nothing of any host.
 */
async function esbuildFacet(ctx, env) {
    const loader = Reflect.get(Object(env), 'LOADER');
    if (!loader || typeof loader.get !== 'function') {
        throw new Error('Nimbus: env.LOADER unavailable for the esbuild facet');
    }
    const assets = Reflect.get(Object(env), 'ASSETS');
    if (!assets || typeof assets.fetch !== 'function') {
        throw new Error('Nimbus: env.ASSETS unavailable for the esbuild facet');
    }
    const worker = await loader.get(ESBUILD_FACET_WORKER_ID, async () => {
        const assetsEnv = { ASSETS: assets };
        const [wasm, jsFnBody, cliRunner, transformRuntime] = await Promise.all([
            fetchEsbuildWasmBytes(assetsEnv),
            fetchEsbuildJsFnBody(assetsEnv),
            fetchEsbuildCliRunner(assetsEnv),
            fetchOxcFacetRuntime(assetsEnv),
        ]);
        return esbuildFacetWorkerCode(wasm, jsFnBody, cliRunner, transformRuntime);
    });
    const facetClass = worker.getDurableObjectClass('EsbuildFacet');
    return ctx.facets.get(ESBUILD_FACET_WORKER_ID, async () => ({ class: facetClass }));
}
/**
 * The one way to a Durable Object's esbuild facet: its `esbuild` commands and
 * the transforms too deep for Oxc share one stub, so a caller that starts
 * while another is still loading the facet (fetching and verifying its
 * staged adapter and runner) waits on that load instead of starting a second one. A load or call
 * that failed drops the entry; the next caller mints a fresh stub.
 */
const sharedFacets = new WeakMap();
function sharedEsbuildFacet(ctx, env) {
    const current = sharedFacets.get(ctx);
    if (current)
        return current;
    const minted = esbuildFacet(ctx, env);
    sharedFacets.set(ctx, minted);
    minted.catch(() => forgetEsbuildFacet(ctx, minted));
    return minted;
}
function forgetEsbuildFacet(ctx, stub) {
    if (sharedFacets.get(ctx) === stub)
        sharedFacets.delete(ctx);
}
/**
 * One call on the shared facet; a call that throws drops the stub it used.
 * The facet's worker is one Dynamic Worker in flight on the ledger for the
 * call's duration — bracketed, never wrapped (see beginLoaderFetch) — and
 * admitted as a helper's is (beginHelperFetch).
 */
async function onEsbuildFacet(ctx, env, call) {
    const stub = sharedEsbuildFacet(ctx, env);
    const endFetch = await beginHelperFetch(ctx, ESBUILD_FACET_WORKER_ID);
    try {
        return await call(await stub);
    }
    catch (error) {
        forgetEsbuildFacet(ctx, stub);
        throw error;
    }
    finally {
        endFetch();
    }
}
/**
 * Where the transform facet sends a module that ran Oxc out of native stack
 * (oxcTransformHost): the esbuild facet, whose Go stacks grow. One call per
 * batch; the caller answers a failed call as transient.
 */
export function esbuildStackFallbackHost(ctx, env) {
    return async (requests) => onEsbuildFacet(ctx, env, (facet) => facet.transformMany(requests));
}
/**
 * Where the build facet sends a build whose rolldown binding died under it
 * (rolldownBuildHost): the esbuild facet, whose Go stacks grow.
 */
export function esbuildBuildFallbackHost(ctx, env) {
    return async (options, plugin) => onEsbuildFacet(ctx, env, (facet) => facet.build(options, plugin));
}
/**
 * Runs one `esbuild` command in the Durable Object's esbuild facet, as
 * process `pid`: its files go through a supervisor capability minted for that
 * pid, the one IsolatePool mints for a facet, and its stdout and stderr come
 * back through `output` as esbuild writes them. Resolves to its exit status.
 */
export async function runEsbuildCli(ctx, env, pid, args, output) {
    const mint = supervisorEntrypoint();
    if (!mint)
        throw new Error('Nimbus: no supervisor entrypoint is composed, so the esbuild facet cannot reach the files');
    const supervisor = mint({
        props: supervisorBindingProps(ctx, pid),
    });
    return onEsbuildFacet(ctx, env, (facet) => facet.cli(args, supervisor, output));
}
/**
 * What a transform from supervisorEsbuildService's host is a function of:
 * the transform facet's code (OXC_FACET_WORKER_ID) and, for a module too deep
 * for it, the esbuild facet's (ESBUILD_FACET_WORKER_ID, which carries the
 * esbuild version). The launch's transform store keys results by it, so a new
 * build of either engine misses every stored result.
 */
export const TRANSFORM_HOST_ID = `${OXC_FACET_WORKER_ID}+${ESBUILD_FACET_WORKER_ID}`;
/**
 * The transforms and builds a Durable Object's supervisor shares: transforms
 * run in its transform facet (oxc-transform.ts), builds in its build facet
 * (build-facet.ts, rolldown), each with the esbuild facet for what its engine
 * cannot finish, and build() reads `vfs` from here. TRANSFORM_HOST_ID is
 * the host's identity, which the launch's transform store keys its results by.
 */
export function supervisorEsbuildService(ctx, env, vfs) {
    return new EsbuildService(vfs, {
        transformHost: oxcTransformHost(ctx, env, esbuildStackFallbackHost(ctx, env)),
        buildHost: rolldownBuildHost(ctx, env, esbuildBuildFallbackHost(ctx, env)),
        transformHostId: TRANSFORM_HOST_ID,
    });
}
