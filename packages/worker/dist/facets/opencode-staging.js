/**
 * opencode-staging.ts — staged-artifact (opencode) facet config assembly.
 *
 * Owns fetching the opencode artifact sources (entry bundle, split-build
 * chunk pack, wasm sidecars, node-shims) and assembling the Worker Loader
 * module map for a facet spawn.
 *
 * WHY THE SPEC IS SEPARATE FROM THE MODULE MAP: the assembled map is ~23 MB
 * of source text (the chunk pack alone is 22.6 MB, decoded a chunk at a time
 * from its bytes), while the spec (argv/env/VFS snapshot) is small. The
 * spawn path only ever builds the spec; `assembleOpencodeFacetConfig` runs
 * inside the Worker-Loader cache-miss callback, so the artifact sources are
 * materialized only when the facet actually loads and only for as long as the
 * load takes. A resident spawn runs that callback in the session DO (measured
 * survivable: 35.7 MB of genuinely-compiled wasm on top of 96 MiB of resident
 * session state, boot id unchanged in 8 of 8 runs, against the 208 MiB
 * envelope), while a one-shot run keeps it in the stateless
 * NimbusLoadedEntrypoint that serves the run.
 *
 * Wasm bytes are memoized per isolate; the chunk pack never stays resident
 * (permanent residency of the artifact sources is what crowded the memory
 * envelope in the first place; the L2 asset cache makes refetches cheap). An
 * assembly runs under the isolate's whole transient budget, so two never
 * overlap (assembleOpencodeFacetConfig).
 */
import { fetchNodeFacetSources } from '../runtime/node-shims-artifact.js';
import { fetchSqliteWasmBytes } from '../runtime/sqlite-wasm-bytes.js';
import { memoizeUntilRejected } from '../runtime/staged-source.js';
import { fetchOpencodeBundle, fetchOpencodeChunkSources, fetchOpencodeWasmBytes, fetchOpencodeWorkerSource, } from '../runtime/opencode-artifact.js';
import { fetchOpenTUIWasmBytes } from '../runtime/opentui-wasm-bytes.js';
import { OPENTUI_WASM_MODULE_NAME } from '../runtime/opentui-facet-backend.js';
import { OPENCODE_CHUNK_RANGES, OPENCODE_CHUNKS_PACK, OPENCODE_TREE_SITTER_WASMS, OPENCODE_TUI_PARSER_WORKER, OPENCODE_YOGA_WASM, } from '../opencode-artifact.generated.js';
import { generateOpencodeRunnerCode, opencodeBuiltinBridgeModules, OPENCODE_BUNDLE_MODULE_NAME, SQLITE_WASM_MODULE_NAME, YOGA_WASM_MODULE_NAME, } from '../runtime/opencode-facet-runner.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { withSupervisorLoadAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES } from '@nimbus-sh/platform/limits.js';
import { OpencodeStageSpecSchema } from './opencode-stage-spec.js';
function requireAssets(env, what) {
    if (!env.ASSETS) {
        throw new Error(`${what} requires an env.ASSETS binding; this Nimbus deployment is ` +
            'missing the static-assets binding');
    }
    return env;
}
// ── Per-isolate wasm byte memoization ────────────────────────────────────────
// Each cache holds one ArrayBuffer (integrity-checked at fetch); facet configs
// share the buffer, workerd compiles the `wasm` module entries ahead of
// dispatch.
const sqliteWasmBytes = memoizeUntilRejected(fetchSqliteWasmBytes);
const openTuiWasmBytes = memoizeUntilRejected(fetchOpenTUIWasmBytes);
const yogaWasmBytes = memoizeUntilRejected(({ env, file }) => fetchOpencodeWasmBytes(env, file));
const treeSitterWasmBytes = memoizeUntilRejected(({ env, files }) => Promise.all(files.map(async (file) => [file, await fetchOpencodeWasmBytes(env, file)])));
/** sql.js wasm `{ wasm }` module entry (shared with the generic facet paths). */
export async function sqliteWasmModuleEntry(env, usesSqlite) {
    if (!usesSqlite)
        return {};
    const assets = requireAssets(env, 'node:sqlite (sql.js wasm)');
    const bytes = await sqliteWasmBytes(assets);
    return { [SQLITE_WASM_MODULE_NAME]: { wasm: bytes } };
}
async function treeSitterModuleEntries(env) {
    const wasms = OPENCODE_TREE_SITTER_WASMS;
    if (!wasms) {
        throw new Error('opencode tree-sitter wasm sidecars are not staged — rerun ' +
            'scripts/bundle-opencode.mjs with the opencode dist present');
    }
    const entries = await treeSitterWasmBytes({ env, files: [wasms.core, wasms.bash, wasms.powershell] });
    return Object.fromEntries(entries.map(([file, bytes]) => [file, { wasm: bytes }]));
}
async function openTuiModuleEntry(env) {
    const bytes = await openTuiWasmBytes(env);
    return { [OPENTUI_WASM_MODULE_NAME]: { wasm: bytes } };
}
async function yogaModuleEntry(env) {
    const yoga = OPENCODE_YOGA_WASM;
    if (!yoga) {
        throw new Error('opencode yoga-layout wasm is not staged — rerun scripts/bundle-opencode.mjs ' +
            'with an opencode dist that extracted yoga.wasm (build-node.ts)');
    }
    const bytes = await yogaWasmBytes({ env, file: yoga });
    return { [YOGA_WASM_MODULE_NAME]: { wasm: bytes } };
}
async function parserWorkerModuleEntry(env) {
    const parser = OPENCODE_TUI_PARSER_WORKER;
    if (!parser) {
        throw new Error('the OpenTUI parser worker bundle is not staged — rerun ' +
            'scripts/bundle-opencode.mjs with an opencode dist that built ' +
            'parser.worker.js (build-node.ts entrypoints)');
    }
    return { [parser]: await fetchOpencodeWorkerSource(env, parser) };
}
function chunkModuleEntries(env) {
    // Flat staging: the entry bundle inlines every chunk (no runtime chunk-graph
    // imports — the #20 process-kill trigger family); there is no pack and no
    // chunk module-map entries.
    if (!OPENCODE_CHUNKS_PACK || !OPENCODE_CHUNK_RANGES)
        return Promise.resolve({});
    return fetchOpencodeChunkSources(env, OPENCODE_CHUNKS_PACK, OPENCODE_CHUNK_RANGES);
}
// A 'staged' boot spec reaching the fabric assembles through
// assembleOpencodeFacetConfig below; the worker's composition root
// (src/index.ts) hands it to the fabric with composeFabric.
/**
 * Assemble the full Worker Loader config for an opencode facet from a stage
 * spec. Returns the config WITHOUT the SUPERVISOR env binding — the caller
 * injects it from a request context that outlives the facet.
 */
export async function assembleOpencodeFacetConfig(env, specInput) {
    const spec = OpencodeStageSpecSchema.parse(specInput);
    const assets = requireAssets(env, 'staged opencode artifact');
    // The map holds more than the isolate's whole transient budget (serve's
    // chunk sources alone are about 38 MB of strings), so the assembly takes all
    // of it and runs alone: two sessions starting opencode at once, or one
    // beside a compile's load, take turns instead of overlapping.
    return await withSupervisorLoadAllocation('opencode facet', SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, undefined, () => assemble(assets, spec));
}
async function assemble(assets, spec) {
    const attached = spec.mode === 'attached';
    const [bundle, sources, sqliteModules, treeSitterModules, openTuiModules, chunkModules, parserModule, yogaModules] = await Promise.all([
        fetchOpencodeBundle(assets, attached ? 'attach' : 'default'),
        fetchNodeFacetSources(assets),
        sqliteWasmModuleEntry(assets, true),
        treeSitterModuleEntries(assets),
        // Rendering stack is attach-only: serve/oneshot never link the TUI
        // graph, and the opentui wasm instance alone costs ~17 MiB of facet
        // memory at module-init.
        attached ? openTuiModuleEntry(assets) : Promise.resolve({}),
        // The attach entry inlines the FULL TUI runtime closure (index-attach.js)
        // and its map carries NO chunk modules: a runtime chunk-graph import —
        // the #20 process-killer — is structurally impossible in the attach
        // facet. Serve/oneshot keep the split build and expand the pack.
        attached ? Promise.resolve({}) : chunkModuleEntries(assets),
        // OpenTUI spawns its syntax-highlight parser as an in-isolate Worker and
        // lays out frames with yoga-layout. Only the attached renderer reaches
        // those; serve + one-shot skip them.
        attached ? parserWorkerModuleEntry(assets) : Promise.resolve({}),
        attached ? yogaModuleEntry(assets) : Promise.resolve({}),
    ]);
    const runner = generateOpencodeRunnerCode({
        argv: spec.argv,
        terminal: spec.terminal,
        cred: spec.cred,
        cwd: spec.cwd,
        stdin: spec.stdin,
        sources,
        vfsBundle: spec.vfsBundle,
        vfsCursor: spec.vfsCursor,
        mode: spec.mode,
    });
    return {
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
        mainModule: 'runner.js',
        modules: {
            'runner.js': runner.code,
            ...Object.fromEntries(Object.entries(runner.codeModules).map(([name, cjs]) => [name, { cjs }])),
            ...Object.fromEntries(Object.entries(runner.immutableModules).map(([name, source]) => [name, { cjs: source.text }])),
            [OPENCODE_BUNDLE_MODULE_NAME]: bundle,
            ...sqliteModules,
            ...treeSitterModules,
            ...openTuiModules,
            ...chunkModules,
            ...parserModule,
            ...yogaModules,
            ...opencodeBuiltinBridgeModules(spec.mode),
        },
    };
}
