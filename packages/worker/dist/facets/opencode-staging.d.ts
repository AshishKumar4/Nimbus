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
export declare const OpencodeStageSpecSchema: z.ZodObject<{
    mode: z.ZodEnum<{
        oneshot: "oneshot";
        attached: "attached";
        server: "server";
    }>;
    argv: z.ZodArray<z.ZodString>;
    env: z.ZodRecord<z.ZodString, z.ZodString>;
    cred: z.ZodObject<{
        uid: z.ZodNumber;
        gid: z.ZodNumber;
        groups: z.ZodArray<z.ZodNumber>;
        umask: z.ZodNumber;
    }, z.core.$strip>;
    cwd: z.ZodString;
    stdin: z.ZodString;
    vfsBundle: z.ZodString;
    vfsManifest: z.ZodString;
    vfsMetadata: z.ZodString;
}, z.core.$strip>;
export type OpencodeStageSpec = z.infer<typeof OpencodeStageSpecSchema>;
/**
 * Memory class the staged runner modes declare to the process fabric
 * (the runtime-spec side of the fabric's single placement policy point).
 * All staged modes are `light` local facets today: the attach TUI's OOM
 * (#35) turned out to be a wasm FFI-ABI bug fixed in the runner itself, so
 * attach no longer needs a peer-process budget — and `heavy` placement costs
 * ~0.5 s of peer-DO cold-create on every spawn. `heavy` remains the
 * live-proven substrate for future multi-process tenants (see
 * loaders/process-fabric.ts).
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