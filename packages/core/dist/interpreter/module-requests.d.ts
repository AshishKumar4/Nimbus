/**
 * One module a module's text asks for, and how: `static` (an import or
 * export-from declaration), `dynamic` (import()) or `require`. The kind
 * decides the resolution, as the loader makes it: a static import is
 * evaluated through the module's scoped require (modules.ts), so it resolves
 * under require's conditions; import() resolves under import's.
 */
export interface ModuleRequest {
    readonly specifier: string;
    readonly kind: 'static' | 'dynamic' | 'require';
}
/**
 * The modules a parsed module asks for: import and export-from sources,
 * `import()` of a string, and `require()` of a string: any call of a
 * `require` binding, the module's own or one createRequire made, by any
 * name. A call of a require wrapper with a string asks for it too: a
 * function whose own body passes its first parameter to such a require, or
 * to its `.resolve` (@vitejs/plugin-vue's `tryRequire(id, from)`, which
 * loads the project's vue/compiler-sfc as `tryRequire("vue/compiler-sfc",
 * root)`). A specifier spelled with escapes or in a template is read as the
 * language reads it; one in a comment or a string is not a request.
 */
export declare function programRequests(program: unknown): ModuleRequest[];
/** Of programRequests, the specifiers a require wrapper's calls name, each once. */
export declare function programWrapperCalls(program: unknown): string[];
//# sourceMappingURL=module-requests.d.ts.map