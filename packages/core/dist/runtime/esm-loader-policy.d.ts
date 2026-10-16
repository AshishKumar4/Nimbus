/**
 * runtime/esm-loader-policy.ts — what Node 22's ES module loader decides
 * before any module is resolved or loaded, for both of Nimbus's loaders: the
 * portable one (substrate/lifo/node-compat/native-esm-loader.ts) and the
 * hosted one (worker runtime/node-shims.ts, which compiles these functions in
 * as ESM_LOADER_POLICY_SOURCE). Self-contained: no imports, so it compiles
 * into a guest preamble whole.
 */
/**
 * import(specifier, options)'s arguments as V8 reads them before the host
 * sees the call (isolate.cc RunHostImportModuleDynamicallyCallback and
 * GetImportAttributesFromArgument, Node 22): the specifier converted to a
 * string first; then `options`, an object or a function, its `with` read
 * once, an object or a function, and each of that's own enumerable string
 * keys read once, a string. Throws V8's TypeError for the first that is not.
 * The arguments are whatever the program passed, so they are typed as such.
 */
export declare function importCallArguments(specifier: unknown, options: unknown): {
    specifier: string;
    attributes: Record<string, string>;
};
/** A data: URL's module, or the MIME type no module format is known for (null when it names none). */
export type DataModule = {
    readonly format: 'module' | 'json';
    readonly source: string;
} | {
    readonly format: null;
    readonly mime: string | null;
};
/**
 * A data: URL module as Node 22's loader reads it: its format by its MIME
 * type (get_format.js getDataProtocolModuleFormat, formats.js mimeToFormat:
 * text/ or application/javascript, with a UTF-8 charset or none, is a
 * module; application/json is JSON), and its source the body as the fetch
 * standard's data: URL processor reads it (the URL but its fragment: the
 * bytes after the first comma, percent-decoded, then base64-decoded when the
 * MIME type ends `;base64`) as UTF-8 text. A body that is not base64 is
 * Node's ERR_INVALID_URL.
 */
export declare function dataModule(url: string): DataModule;
//# sourceMappingURL=esm-loader-policy.d.ts.map