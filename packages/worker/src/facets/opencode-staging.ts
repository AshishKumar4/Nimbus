/**
 * opencode-staging.ts — staged-artifact (opencode) facet config assembly.
 *
 * Owns fetching the opencode artifact sources (entry bundle, split-build
 * chunk pack, wasm sidecars, node-shims) and assembling the Worker Loader
 * module map for a facet spawn.
 *
 * WHY THE SPEC IS SEPARATE FROM THE MODULE MAP: the assembled map is ~23 MB
 * of source text (the chunk pack alone is 22.6 MB) plus a 22.6 MB fetch +
 * JSON.parse transient, while the spec (argv/env/VFS snapshot) is small. The
 * spawn path only ever builds the spec; `assembleOpencodeFacetConfig` runs
 * inside the Worker-Loader cache-miss callback, so the artifact sources are
 * materialized only when the facet actually loads and only for as long as the
 * load takes. A resident spawn runs that callback in the session DO (measured
 * survivable: 35.7 MB of genuinely-compiled wasm on top of 96 MiB of resident
 * session state, boot id unchanged in 8 of 8 runs, against the 208 MiB
 * envelope), while a one-shot run keeps it in the stateless
 * NimbusLoadedEntrypoint that serves the run.
 *
 * Wasm bytes are memoized per isolate; the chunk-pack fetch+parse is
 * deduped while in flight but never stays resident (permanent residency of
 * the artifact sources is what crowded the memory envelope in the first
 * place; the L2 asset cache makes refetches cheap).
 */

import { z } from 'zod/v4';
import { fetchNodeShimsCode } from '../runtime/node-shims-artifact.js';
import { fetchSqliteWasmBytes } from '../runtime/sqlite-wasm-bytes.js';
import {
  fetchOpencodeBundle,
  fetchOpencodeChunkSources,
  fetchOpencodeWasmBytes,
  fetchOpencodeWorkerSource,
} from '../runtime/opencode-artifact.js';
import { fetchOpenTUIWasmBytes } from '../runtime/opentui-wasm-bytes.js';
import { OPENTUI_WASM_MODULE_NAME } from '../runtime/opentui-facet-backend.js';
import {
  OPENCODE_CHUNKS_PACK,
  OPENCODE_TREE_SITTER_WASMS,
  OPENCODE_TUI_WORKERS,
  OPENCODE_YOGA_WASM,
} from '../opencode-artifact.generated.js';
import {
  generateOpencodeRunnerCode,
  opencodeBuiltinBridgeModules,
  OPENCODE_BUNDLE_MODULE_NAME,
  SQLITE_WASM_MODULE_NAME,
  YOGA_WASM_MODULE_NAME,
} from '../runtime/opencode-facet-runner.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { CF_COMPAT_DATE } from '@nimbus-sh/core/constants.js';

export interface OpencodeAssetsEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/**
 * Everything a facet spawn needs beyond the artifact sources themselves.
 * Small enough to ride in NimbusLoadedEntrypoint props (the VFS snapshot is
 * the only variable-size member; it is bounded by the prefetch-bundle caps).
 */
export const OpencodeStageSpecSchema = z.object({
  mode: z.enum(['oneshot', 'attached', 'server']),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cred: z.object({
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    groups: z.array(z.number().int().nonnegative()),
    umask: z.number().int().nonnegative(),
  }),
  cwd: z.string(),
  stdin: z.string(),
  /** Serialized VFS snapshot bundle (`_serializeBundleForFacet` output). */
  vfsBundle: z.string(),
  /** Serialized VFS directory manifest (JSON). */
  vfsManifest: z.string(),
  /** Serialized VFS inode metadata (JSON). */
  vfsMetadata: z.string(),
  /**
   * The coherence cursor the three above were read at, as a JSON literal
   * (`null` when the stage carries no VFS). Without it the facet's first
   * ACQUIRE poisons and drops the whole snapshot — see _shared/facet-vfs-cursor.
   */
  vfsCursor: z.string(),
});

export type OpencodeStageSpec = z.infer<typeof OpencodeStageSpecSchema>;

function requireAssets(env: Partial<OpencodeAssetsEnv>, what: string): OpencodeAssetsEnv {
  if (!env.ASSETS) {
    throw new Error(
      `${what} requires an env.ASSETS binding; this Nimbus deployment is ` +
        'missing the static-assets binding',
    );
  }
  return env as OpencodeAssetsEnv;
}

// ── Per-isolate wasm byte memoization ────────────────────────────────────────
// Each cache holds one ArrayBuffer (integrity-checked at fetch); facet configs
// share the buffer, workerd compiles the `wasm` module entries ahead of
// dispatch.

let sqliteWasmBytes: Promise<ArrayBuffer> | null = null;
let openTuiWasmBytes: Promise<ArrayBuffer> | null = null;
let yogaWasmBytes: Promise<ArrayBuffer> | null = null;
let treeSitterWasmBytes: Promise<ReadonlyArray<readonly [string, ArrayBuffer]>> | null = null;

function memoized<T>(
  slot: Promise<T> | null,
  set: (p: Promise<T> | null) => void,
  create: () => Promise<T>,
): Promise<T> {
  if (!slot) {
    const p = create();
    set(p);
    p.catch(() => set(null));
    return p;
  }
  return slot;
}

/** sql.js wasm `{ wasm }` module entry (shared with the generic facet paths). */
export async function sqliteWasmModuleEntry(
  env: Partial<OpencodeAssetsEnv>,
  usesSqlite: boolean,
): Promise<Record<string, { wasm: ArrayBuffer }>> {
  if (!usesSqlite) return {};
  const assets = requireAssets(env, 'node:sqlite (sql.js wasm)');
  const bytes = await memoized(sqliteWasmBytes, (p) => { sqliteWasmBytes = p; }, () =>
    fetchSqliteWasmBytes(assets));
  return { [SQLITE_WASM_MODULE_NAME]: { wasm: bytes } };
}

async function treeSitterModuleEntries(
  env: OpencodeAssetsEnv,
): Promise<Record<string, { wasm: ArrayBuffer }>> {
  const wasms = OPENCODE_TREE_SITTER_WASMS;
  if (!wasms) {
    throw new Error(
      'opencode tree-sitter wasm sidecars are not staged — rerun ' +
        'scripts/bundle-opencode.mjs with the opencode dist present',
    );
  }
  const entries = await memoized(treeSitterWasmBytes, (p) => { treeSitterWasmBytes = p; }, async () =>
    Promise.all(
      [wasms.core, wasms.bash, wasms.powershell].map(
        async (file) => [file, await fetchOpencodeWasmBytes(env, file)] as const,
      ),
    ));
  return Object.fromEntries(entries.map(([file, bytes]) => [file, { wasm: bytes }]));
}

async function openTuiModuleEntry(
  env: OpencodeAssetsEnv,
): Promise<Record<string, { wasm: ArrayBuffer }>> {
  const bytes = await memoized(openTuiWasmBytes, (p) => { openTuiWasmBytes = p; }, () =>
    fetchOpenTUIWasmBytes(env));
  return { [OPENTUI_WASM_MODULE_NAME]: { wasm: bytes } };
}

async function yogaModuleEntry(
  env: OpencodeAssetsEnv,
): Promise<Record<string, { wasm: ArrayBuffer }>> {
  const yoga = OPENCODE_YOGA_WASM;
  if (!yoga) {
    throw new Error(
      'opencode yoga-layout wasm is not staged — rerun scripts/bundle-opencode.mjs ' +
        'with an opencode dist that extracted yoga.wasm (build-node.ts)',
    );
  }
  const bytes = await memoized(yogaWasmBytes, (p) => { yogaWasmBytes = p; }, () =>
    fetchOpencodeWasmBytes(env, yoga));
  return { [YOGA_WASM_MODULE_NAME]: { wasm: bytes } };
}

async function tuiWorkerModuleEntries(env: OpencodeAssetsEnv): Promise<Record<string, string>> {
  const workers = OPENCODE_TUI_WORKERS;
  if (!workers) {
    throw new Error(
      'opencode TUI worker bundles are not staged — rerun ' +
        'scripts/bundle-opencode.mjs with an opencode dist that built ' +
        'worker.js + parser.worker.js (build-node.ts entrypoints)',
    );
  }
  // Parser only: the TUI's API-server worker (worker.js) is answered by the
  // in-polyfill RPC stub and NEVER imported (defect #20 — its chunk graph is a
  // process-killer), and the attach map carries no chunk modules, so the real
  // worker.js's import graph could not even link.
  const entries = await Promise.all(
    [workers.parser].map(
      async (file) => [file, await fetchOpencodeWorkerSource(env, file)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

// In-flight (never resident) chunk-pack fetch+parse dedupe: concurrent
// assemblies in the same isolate share one fetch + ~22 MB JSON parse.
let chunkEntriesInflight: Promise<Record<string, string>> | null = null;

function chunkModuleEntries(env: OpencodeAssetsEnv): Promise<Record<string, string>> {
  // Flat staging: the entry bundle inlines every chunk (no runtime chunk-graph
  // imports — the #20 process-kill trigger family); there is no pack and no
  // chunk module-map entries.
  if (!OPENCODE_CHUNKS_PACK) return Promise.resolve({});
  if (!chunkEntriesInflight) {
    chunkEntriesInflight = fetchOpencodeChunkSources(env, OPENCODE_CHUNKS_PACK).finally(() => {
      chunkEntriesInflight = null;
    });
  }
  return chunkEntriesInflight;
}

// A 'staged' boot spec reaching the fabric assembles through
// assembleOpencodeFacetConfig below; the worker's composition root
// (src/index.ts) hands it to the fabric with composeFabric.

/**
 * Assemble the full Worker Loader config for an opencode facet from a stage
 * spec. Returns the config WITHOUT the SUPERVISOR env binding — the caller
 * injects it from a request context that outlives the facet.
 */
export async function assembleOpencodeFacetConfig(
  env: Partial<OpencodeAssetsEnv>,
  specInput: unknown,
): Promise<WorkerCode> {
  const spec = OpencodeStageSpecSchema.parse(specInput);
  const assets = requireAssets(env, 'staged opencode artifact');
  const attached = spec.mode === 'attached';

  const [bundle, shimsCode, sqliteModules, treeSitterModules, openTuiModules, chunkModules, workerModules, yogaModules] =
    await Promise.all([
      fetchOpencodeBundle(assets, attached ? 'attach' : 'default'),
      fetchNodeShimsCode(assets),
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
      // The TUI client spawns its API server + OpenTUI parser as in-isolate
      // Workers, and OpenTUI lays out frames with yoga-layout. Only the
      // attached renderer reaches those; serve + one-shot skip them.
      attached ? tuiWorkerModuleEntries(assets) : Promise.resolve({}),
      attached ? yogaModuleEntry(assets) : Promise.resolve({}),
    ]);

  const runnerCode = generateOpencodeRunnerCode({
    argv: spec.argv,
    env: spec.env,
    cred: spec.cred,
    cwd: spec.cwd,
    stdin: spec.stdin,
    shimsCode,
    vfsBundle: spec.vfsBundle,
    vfsManifest: spec.vfsManifest,
    vfsMetadata: spec.vfsMetadata,
    vfsCursor: spec.vfsCursor,
    mode: spec.mode,
  });

  return {
    compatibilityDate: CF_COMPAT_DATE,
    compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
    mainModule: 'runner.js',
    modules: {
      'runner.js': runnerCode,
      [OPENCODE_BUNDLE_MODULE_NAME]: bundle,
      ...sqliteModules,
      ...treeSitterModules,
      ...openTuiModules,
      ...chunkModules,
      ...workerModules,
      ...yogaModules,
      ...opencodeBuiltinBridgeModules(attached),
    },
  };
}
