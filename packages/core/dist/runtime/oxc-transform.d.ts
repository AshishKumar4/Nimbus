/**
 * oxc-transform.ts — esbuild's `transform()` contract, run by Nimbus's Oxc
 * build (packages/worker/scripts/oxc-wasm).
 *
 * `createOxcTransform(module)` answers the esbuild transform calls Nimbus
 * makes (esbuild-service.ts's transformWithEsbuild and runTransformRequest)
 * with the same output contract: the loaders `js`, `jsx`, `ts` and `tsx`;
 * `format` unset (module syntax kept), `esm` or `cjs` with esbuild's interop
 * helpers and `__esModule` marking; `define`; `supported['dynamic-import']`
 * and `supported['import-meta']`; JSX classic, automatic or preserved (for
 * ES module output only: preserved JSX in CommonJS would name imports that
 * conversion moved onto records, and nothing in Nimbus asks for it);
 * source maps returned or inlined; and esbuild's error message shape, down to
 * the top-level-await refusal the caller recognizes. Anything else a caller
 * asks for (another target, minify, a tsconfig, CSS) is refused rather than
 * ignored: there is no caller for it, and silently doing less would be wrong.
 *
 * The wasm imports nothing and keeps nothing between calls; its linear
 * memory, which only grows, is the largest module's working set. An instance
 * whose memory passed `retireAboveBytes` is dropped after its call, and one
 * that trapped is never called again: the next call instantiates afresh.
 *
 * Oxc's passes recurse once per level of nesting, on the host's native stack.
 * A module nested deeper than that stack holds (a concatenation of some ten
 * thousand terms under workerd) fails with an error whose `stackExhausted` is
 * true, set here from the RangeError the wasm call threw and from nothing
 * else; the transform facet carries it in the outcome, and its host sends such
 * a module to esbuild instead (facets/oxc-transform.ts).
 *
 * No imports: the transform facet's runtime bundles it (oxc-facet/preamble.ts).
 */
/** Whether `error` is a transform's report that it ran out of native stack. */
export declare function isOxcStackExhaustion(error: unknown): boolean;
export interface OxcTransformOptions {
    loader?: string;
    format?: string;
    target?: string;
    sourcemap?: boolean | string;
    sourcefile?: string;
    minify?: boolean;
    jsx?: string;
    jsxFactory?: string;
    jsxFragment?: string;
    tsconfigRaw?: string | object;
    define?: Record<string, string>;
    supported?: Record<string, boolean>;
}
export interface OxcLocation {
    file: string;
    namespace: string;
    line: number;
    column: number;
    length: number;
    lineText: string;
    suggestion: string;
}
export interface OxcMessage {
    id: string;
    pluginName: string;
    text: string;
    location: OxcLocation | null;
    notes: never[];
    detail: undefined;
}
export interface OxcTransformResult {
    code: string;
    map: string;
    warnings: OxcMessage[];
}
export interface OxcTransform {
    transform(code: string, options?: OxcTransformOptions): Promise<OxcTransformResult>;
    /** The live instance's linear memory, 0 when there is none. */
    memoryBytes(): number;
    /** AST arena bytes the last transform used and reserved. */
    lastArena(): {
        used: number;
        reserved: number;
    };
}
export declare function createOxcTransform(module: WebAssembly.Module, { retireAboveBytes }?: {
    retireAboveBytes?: number;
}): OxcTransform;
//# sourceMappingURL=oxc-transform.d.ts.map