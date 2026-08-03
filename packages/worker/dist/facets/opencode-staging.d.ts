/**
 * opencode-staging.ts — staged-artifact (opencode) facet config assembly.
 *
 * Owns fetching the opencode artifact sources (entry bundle, split-build
 * chunk pack, wasm sidecars, node-shims) and assembling the Worker Loader
 * module map for a facet spawn.
 *
 * WHY THIS IS NOT PART OF FacetManager: the assembled module map is ~23 MB
 * of source text (the chunk pack alone is 22.6 MB) plus a 22.6 MB fetch +
 * JSON.parse transient. Materializing that inside the supervisor Durable
 * Object pushed its isolate over the 128 MiB cap and workerd reset it —
 * wiping the port registry and process table mid-spawn (live-diagnosed
 * 2026-07-16, `exceededMemory` in the tail during the dual serve+attach
 * boot). The supervisor therefore only builds a small OpencodeStageSpec
 * (argv/env/VFS snapshot); NimbusLoadedEntrypoint (a STATELESS worker
 * entrypoint, its own isolate) calls `assembleOpencodeFacetConfig` inside
 * the Worker-Loader cache-miss callback, so the artifact sources are
 * materialized outside the DO heap, only when the facet actually loads.
 *
 * Wasm bytes are memoized per isolate; the chunk-pack fetch+parse is
 * deduped while in flight but never stays resident (permanent residency of
 * the artifact sources is what crowded the memory envelope in the first
 * place; the L2 asset cache makes refetches cheap).
 */
import { z } from 'zod/v4';
import type { WorkerCode } from '../loaders/vendor/types.js';
import type { ProcessClass } from '../loaders/process-fabric.js';
export interface OpencodeAssetsEnv {
    ASSETS: {
        fetch(req: Request): Promise<Response>;
    };
}
/**
 * Everything a facet spawn needs beyond the artifact sources themselves.
 * Small enough to ride in NimbusLoadedEntrypoint props (the VFS snapshot is
 * the only variable-size member; it is bounded by the prefetch-bundle caps).
 */
export declare const OpencodeStageSpecSchema: any;
export type OpencodeStageSpec = z.infer<typeof OpencodeStageSpecSchema>;
/**
 * Memory class each staged mode declares to the process fabric — the
 * runtime-spec side of its single placement policy point.
 *
 * `attached` is heavy. It is resident — its memory grows with the conversation
 * and the project loaded — and it binds no port: the TUI streams ANSI frames
 * out over the terminal RPC and takes keystrokes in over the stdin pump. Its
 * OOM kills the process instead of resetting the session.
 *
 * `server` is equally resident but BINDS A PORT, and the peer-hosted
 * inbound-HTTP leg is still broken (see `loaders/process-fabric.ts`), so it
 * stays local. Even once that is fixed it needs measurement before moving:
 * its readiness gate polls `/doc` in-DO on a 200 ms cadence inside a 30 s
 * budget, so every poll would become a peer round trip during the window when
 * the peer is coldest, on top of a ~0.5 s peer-DO cold-create.
 *
 * `oneshot` buffers a single run and returns; it would pay the peer cold-create
 * for nothing, and it takes the one-shot fetch path, which never reaches the
 * fabric at all.
 */
export declare function stagedProcessClass(mode: OpencodeStageSpec['mode']): ProcessClass;
/** sql.js wasm `{ wasm }` module entry (shared with the generic facet paths). */
export declare function sqliteWasmModuleEntry(env: Partial<OpencodeAssetsEnv>, usesSqlite: boolean): Promise<Record<string, {
    wasm: ArrayBuffer;
}>>;
/**
 * Assemble the full Worker Loader config for an opencode facet from a stage
 * spec. Returns the config WITHOUT the SUPERVISOR env binding — the caller
 * injects it from a request context that outlives the facet.
 */
export declare function assembleOpencodeFacetConfig(env: Partial<OpencodeAssetsEnv>, specInput: unknown): Promise<WorkerCode>;
//# sourceMappingURL=opencode-staging.d.ts.map