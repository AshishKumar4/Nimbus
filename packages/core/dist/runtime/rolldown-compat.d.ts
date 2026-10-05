/**
 * rolldown-compat.ts - what a rolldown build (rolldown-build.ts) does for one
 * module so that it comes out as esbuild 0.24 made it, where rolldown's own
 * transform cannot: its options are the whole build's, and a few of
 * esbuild's settings are per file or need what rolldown's transform does not
 * do. The load hook asks compileForBuild once per module and gets back null
 * (rolldown compiles the module itself) or the module compiled here.
 *
 * Nothing here rewrites language source as text. Modules are read through
 * rolldown's binding parser (parseSync: ESTree, UTF-16 offsets, comments
 * apart from code) and compiled by its transform (transformSync, rolldown's
 * own Oxc), given the module's absolute path and the build's options except
 * for what each function names. The only edits are to that transform's
 * output, at nodes the parser placed, each as long as what it replaces, so
 * the transform's source map (which maps to the module as written) stays
 * the map; and one that moves whole lines of it (decorators into tsc's
 * order), moving the map's lines with them.
 *
 * Self-contained but for types: the build facet's runtime bundles it.
 */
import type { TsSettings } from './tsconfig-raw.js';
/** What this module calls of rolldown's binding (rolldown/experimental). */
export interface CompatApi {
    transformSync(filename: string, source: string, options: Record<string, unknown>): {
        code: string;
        map?: unknown;
        errors: unknown[];
    };
    parseSync(filename: string, source: string, options?: Record<string, unknown>): {
        program: unknown;
        comments: unknown[];
        errors: unknown[];
    };
}
/** A module as the load hook has it. */
export interface CompatModule {
    /** Its absolute path: the name the transform gives jsxDEV's `fileName`. */
    path: string;
    text: string;
    loader: string;
    /** Whether the build makes a source map. */
    sourcemap: boolean;
}
/** A module compiled here: JavaScript, or JSX where the build preserves it. */
export interface CompatCompiled {
    code: string;
    map?: unknown;
    moduleType: 'js' | 'jsx';
}
/** rolldown's (Oxc's) JSX and TypeScript options for the settings; `fragment` names the classic fragment in place of theirs. */
export declare function jsxAndTypescriptOf(settings: TsSettings, fragment?: string | null): {
    jsx: unknown;
    typescript: Record<string, unknown>;
};
/**
 * The module as a build must compile it: null for rolldown's own transform
 * (which then makes it as esbuild did), or the compiled module. Throws where
 * it needs rolldown's transform or parser and the build has none.
 */
export declare function compileForBuild(api: Partial<CompatApi>, settings: TsSettings, module: CompatModule): CompatCompiled | null;
//# sourceMappingURL=rolldown-compat.d.ts.map