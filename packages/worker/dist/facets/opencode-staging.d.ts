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
import type { WorkerCode } from '../loaders/vendor/types.js';
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