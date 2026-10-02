/**
 * rolldown-build.ts — esbuild's build contract (EsbuildBuildHost:
 * esbuild-shaped options and a remote resolve/load plugin), run by rolldown.
 *
 * Every Nimbus build serves its modules from a plugin (EsbuildService's VFS
 * plugin, the pre-bundle facet's slice plugin), so rolldown never reads a
 * file: each import goes to `plugin.resolve` with esbuild's arguments (path,
 * importer, namespace, resolveDir, kind) and each module to `plugin.load`,
 * whose esbuild-shaped answer (contents, loader, resolveDir, errors) becomes
 * rolldown's. esbuild keys a module on (namespace, path); here a module of the
 * plugin's main namespace keeps its path as its id, so names of outputs come
 * from files as esbuild's do, and any other namespace is `\0<ns>:<path>`.
 *
 * What a caller reads comes back as esbuild gave it: output files at
 * `outdir/<name>` (or `outfile`), the metafile subset callers read (each
 * output's `entryPoint`, `cssBundle`, `bytes`), diagnostics as `{ text,
 * location }`, and a failed build as esbuild's "Build failed with N errors:"
 * message, its diagnostics alongside. Options no caller uses are refused
 * rather than ignored. CSS is bundled by css-bundle.ts, as esbuild bundled it.
 *
 * Self-contained but for types and css-bundle.ts: the build facet's runtime
 * bundles it (rolldown-facet/preamble.ts).
 */
import type * as esbuild from 'esbuild-wasm';
import type { EsbuildBuildOutcome, EsbuildHostBuildOptions, EsbuildRemotePlugin } from './esbuild-service.js';
/** The part of rolldown's JavaScript API a build uses. */
export interface RolldownApi {
    rolldown(options: Record<string, unknown>): Promise<{
        generate(options: Record<string, unknown>): Promise<{
            output: RolldownOutput[];
        }>;
        close(): Promise<void>;
    }>;
}
type RolldownOutput = {
    type: 'chunk';
    fileName: string;
    code: string;
    isEntry: boolean;
    facadeModuleId: string | null;
    moduleIds: string[];
    exports: string[];
    map?: {
        toString(): string;
    } | null;
} | {
    type: 'asset';
    fileName: string;
    source: string | Uint8Array;
};
/** `Build failed with N errors:` and one line per error, as esbuild words its rejection. */
export declare function esbuildFailureText(errors: readonly esbuild.Message[]): string;
export declare function buildWithRolldown(api: RolldownApi, options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin): Promise<EsbuildBuildOutcome>;
export {};
//# sourceMappingURL=rolldown-build.d.ts.map