/**
 * What a module's require wrappers load: a function that passes its first
 * parameter to a require (the module's own, or one createRequire made, by any
 * name), or to its `.resolve`, loads what each of its calls names with a
 * string. @vitejs/plugin-vue loads the project's compiler so:
 *
 *   const _require = createRequire(import.meta.url);
 *   function tryRequire(id, from) {
 *     try { return from ? _require(_require.resolve(id, { paths: [from] })) : _require(id); } catch (e) {}
 *   }
 *   … tryRequire("vue/compiler-sfc", root) …
 *
 * No other grammar reads that call, and a Vue project's first `vite` and
 * `vite build` failed on what it loads. The calls are read by the analysis
 * the runtime's import() prefetch reads them with
 * (core/interpreter/module-requests.ts programWrapperCalls), over the parsed
 * module. Only a module whose tokens could hold one is parsed
 * (mayCallRequireWrapper): almost none do. The supervisor keeps what a
 * revision of a file answers (RequireFs.wrapperCalls), so a launch reads it
 * and only the first walk after a write pays.
 */
export declare function requireWrapperCalls(code: string): string[];
/**
 * Whether `source` could call a require wrapper as the analysis reads one,
 * read from its tokens (names with their escapes read, strings, regular
 * expressions and comments told apart, as the parse tells them): a require
 * (`require`, or a name createRequire's value is assigned to) called with a
 * name first, maybe parenthesized, optional or through `.resolve`; a named
 * function (a declaration, or a function or arrow assigned to a name) whose
 * first parameter has that name; and a call of that function's name with a
 * string first. Each is implied by a wrapper call the analysis reads, so a
 * module it turns away has none, whatever its forms.
 */
export declare function mayCallRequireWrapper(source: string): boolean;
//# sourceMappingURL=require-wrappers.d.ts.map