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
 * The modules a program asks for, read node by node in post-order (each
 * node after its children), as acorn finishes them: a whole tree walked so
 * (programRequests), or a parse that keeps no tree of the program
 * (core/runtime/require-wrappers.ts, parseStatements' onNode). Nothing it
 * keeps refers to a node once that node's parent is read, so a parse that
 * drops each statement as it goes holds no more than it would.
 */
export declare class RequestCollector {
    private readonly requests;
    private readonly made;
    private readonly passed;
    private readonly functions;
    private readonly candidates;
    private readonly calls;
    private add;
    private candidate;
    /** Read `node`, every one of whose children has been read. */
    visit(node: unknown): void;
    /** The requests, once every node is read: the program's, and the specifiers a require wrapper's calls name. */
    finish(): {
        requests: ModuleRequest[];
        wrapperCalls: string[];
    };
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
/** `specifiers`, each once, in order. */
export declare function uniqueSpecifiers(specifiers: readonly string[]): string[];
//# sourceMappingURL=module-requests.d.ts.map