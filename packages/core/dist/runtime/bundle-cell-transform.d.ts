/**
 * bundle-cell-transform.ts — what the session does to one staged module
 * before it can run as a module cell.
 *
 * Every cell a process can require is CommonJS by the time it is wrapped
 * (commonjs-cell.ts): the guest's registry could compile an ES module, but
 * cannot resolve its package imports, give it its own file URL, or import
 * names from the CommonJS it depends on. So an ES module or a TypeScript
 * source is lowered to CommonJS, and a CommonJS cell's dynamic `import()`
 * calls are routed to the process's ESM loader.
 *
 * A cell's result is a function of four things: its path, its source, this
 * pipeline's code, and the transform host's code. That is what lets a
 * launch's results be kept by content (the worker's TransformStore): each is
 * stored under the sha256 of all four, and the build pins the pipeline's code
 * as TRANSFORM_PIPELINE_ID (scripts/bundle-facet-workers.mjs hashes the
 * bundled closure of this module and EsbuildService), so a deploy that
 * changes any step here never serves a result the old steps produced.
 * Nothing that decides a cell's output may live outside that closure.
 */
import { type EsbuildTransformOutcome, type EsbuildTransformRequest } from './esbuild-service.js';
/**
 * Bundled ESM this large is lowered by the bounded declaration rewrite in the
 * session rather than by esbuild: esbuild's Go heap grows with the module and
 * is never released.
 */
export declare const BUNDLED_ESM_REWRITE_MIN_BYTES: number;
/**
 * The bundle entries that may need the ESM→CJS transform before they can run
 * as module cells.
 *
 * Extensionless entries are in the set because that is the shape of nearly
 * every npm `bin` script. `.json` is data and `.cjs` is CommonJS by
 * definition; neither needs the transform. Content decides from here:
 * `looksLikeEsm` sniffs module syntax, and parses an extensionless file,
 * which may be data rather than a script.
 */
export declare function isBundleModuleCandidate(path: string): boolean;
/**
 * The esbuild loader for a TypeScript source in the bundle, or null when the
 * path does not name one. Which extensions are TypeScript is
 * `typescriptLoader`'s table, the one a runtime's entry script is decided by.
 *
 * A resolved `.ts` file reaches the facet as TypeScript, and TypeScript is not
 * JavaScript: compiling a type annotation is a SyntaxError whether or
 * not the file has a single import in it. So these transform on their
 * EXTENSION, where `.js` files transform on their content — `looksLikeEsm` is
 * the right question for a file that is already valid JS either way, and the
 * wrong one for a file that is never valid JS.
 *
 * A declaration file (`.d.ts`, `.d.mts`, `.d.cts`) is not a source: it has
 * no runtime form, nothing `require()`s one, and esbuild's output for it is
 * empty by definition. It is DATA — read by the program that ships it, which
 * is exactly typescript: `tsc` reads its own `lib/lib.*.d.ts` with
 * `readFileSync`, and every declaration it type-checks against comes from
 * those bytes. Transforming them handed the compiler an 811-byte license
 * comment where `lib.es5.d.ts` (217 KB) had been, and every global type was
 * gone. So a declaration file is left exactly as it was staged.
 */
export declare function bundleTypescriptLoader(path: string): 'ts' | 'tsx' | null;
/** `name.d.ts` / `name.d.mts` / `name.d.cts`, by TypeScript's own rule. */
export declare function isTypescriptDeclarationFile(path: string): boolean;
/** Whether a JavaScript file is an ES module: module syntax, and for an extensionless file, a parse. */
export declare function looksLikeEsm(path: string, src: string): boolean;
/**
 * Whether the staged cell at `path` goes through the pipeline at all: an ES
 * module or TypeScript source to lower, or CommonJS (`.cjs` included) whose
 * dynamic `import()` calls are the process's.
 */
export declare function needsBundleCellTransform(path: string, src: string): boolean;
/**
 * Parseable CommonJS standing in for a module esbuild could not transform: it
 * throws the esbuild reason when required, so the failure surfaces at the
 * `require` with its cause rather than as a bare "Cannot use import statement".
 */
export declare function esbuildDiagnosticShim(path: string, reason: string): string;
/** One cell part-way through the pipeline: the session's steps are done, the host's may remain. */
export type BundleCell = {
    readonly path: string;
    /** A TypeScript source: its emit becomes the module cell, and the source keeps its bytes. */
    readonly typescript: boolean;
    /** Lowered from ESM, so its module's block scope applies (commonjs-cell.ts THE WRAPPER). */
    readonly lowered: boolean;
    readonly absUrl: string;
} & (
/** The host's step: one transform request. */
{
    readonly request: EsbuildTransformRequest;
}
/** Settled in the session: the bounded rewrite's answer, or a source the pre-pass cannot read. */
 | {
    readonly outcome: EsbuildTransformOutcome;
});
/** What a cell stages as, and what a store keeps for it. */
export interface BundleCellResult {
    /** The cell's code: CommonJS, the TypeScript emit, or the diagnostic shim. */
    readonly code: string;
    readonly lowered: boolean;
    /** esbuild's verdict was a rejection, and `code` is the shim that reports it. */
    readonly failed: boolean;
}
/**
 * Run the session's steps of the pipeline on `source`, staged at `path`.
 *
 * This is computation in the caller's isolate proportional to the source —
 * the provided-module pre-pass and, for large bundled ESM, the bounded
 * declaration rewrite — so a paced caller accounts the source before it.
 */
export declare function prepareBundleCell(path: string, source: string): BundleCell;
/**
 * The cell's result from the host's (or the session's) outcome. A transient
 * error is no verdict on the source — the host could not run the transform
 * this time — so it throws, before any bundle, image or store can keep a
 * diagnostic that would poison the next launch.
 */
export declare function settleBundleCell(cell: BundleCell, outcome: EsbuildTransformOutcome): BundleCellResult;
/**
 * The entry script as the facet compiles it: each dynamic `import()` routed to
 * the process's ESM loader, with `parentUrl` (the script's own URL) as the
 * parent. Its result is the host's code as returned.
 */
export declare function entryScriptRequest(code: string, parentUrl: string): EsbuildTransformRequest;
/**
 * Transform results kept across launches, by content: the worker's
 * TransformStore over the session's SQLite. A store is bound to the transform
 * host whose results it holds, so its keys already name that host's code.
 */
export interface BundleCellResultStore {
    /**
     * The content address of `source` staged at `at` as a `kind`: a module
     * cell at its bundle path, or an entry script at its URL.
     */
    key(kind: 'cell' | 'entry', at: string, source: string): Promise<string>;
    /** The results held for `keys`; a key the store does not hold is absent. */
    getMany(keys: readonly string[]): Map<string, BundleCellResult>;
    /**
     * Keep `result` under `key`. `spend` accounts each slice written, so a
     * paced caller's writes land on as many turns as they take. Never throws:
     * a result the store cannot keep costs the next launch a transform.
     */
    put(key: string, result: BundleCellResult, spend?: (bytes: number) => Promise<void>): Promise<void>;
}
//# sourceMappingURL=bundle-cell-transform.d.ts.map