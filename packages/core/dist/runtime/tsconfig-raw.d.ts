/**
 * tsconfig-raw.ts — esbuild 0.24's reading of `tsconfigRaw` and of its own
 * JSX options, for the engines that replaced it: the Oxc transform
 * (oxc-transform.ts) and the rolldown builds (rolldown-build.ts). Both take
 * esbuild's options, so both read them through here, as esbuild did
 * (internal/resolver/tsconfig_json.go and internal/config/config.go at
 * v0.24.2, measured against esbuild-wasm 0.24.2 in
 * tests/unit/tsconfig-jsx-differential.mjs).
 *
 * JSX. The options set first, then `compilerOptions` over them: esbuild
 * applies the tsconfig's settings after its own options, so a tsconfig's
 * `jsx`, `jsxFactory`, `jsxFragmentFactory` and `jsxImportSource` win over
 * `jsx: 'automatic'`, `jsxFactory`, `jsxFragment` and `jsxImportSource`.
 * `"react"` turns the automatic runtime and development off, `"react-jsx"`
 * turns the runtime on, `"react-jsxdev"` both; `"preserve"`,
 * `"react-native"` and anything else are ignored (esbuild preserves JSX only
 * for its own `jsx: 'preserve'`, which no tsconfig undoes). An import source
 * and development apply only to the automatic runtime, a factory and
 * fragment only to the classic one. esbuild's own `jsxFragment` may also be
 * a primitive constant (`0`, `"frag"`, `null`), its own factory not.
 *
 * Every other field is honoured where the engines can produce esbuild's
 * output, refused by name where they cannot (a build's `extends` naming a
 * file), and ignored where esbuild ignores it (resolveTsSettings says which,
 * and why). `experimentalDecorators` and `useDefineForClassFields: false`
 * (or a `target` that implies it) change TypeScript files only, as in
 * esbuild: legacy decorators, applied in tsc's order, and class fields
 * assigned rather than defined (TsSettings). `alwaysStrict` (else
 * `strict`) makes every file strict code, as esbuild parses it: what only a
 * sloppy script may contain is an error, and CommonJS and IIFE output begins
 * with `"use strict"`.
 */
/** The esbuild options this module reads. */
export interface TsconfigInputs {
    jsx?: string;
    jsxFactory?: string;
    jsxFragment?: string;
    jsxImportSource?: string;
    jsxDev?: boolean;
    tsconfigRaw?: string | object;
}
/** What a transform or build does with JSX and TypeScript, as esbuild would. */
export interface TsSettings {
    jsx: {
        /** JSX kept as written (only esbuild's own `jsx: 'preserve'` asks for it). */
        preserve: boolean;
        /** React's automatic runtime (`react/jsx-runtime`); otherwise the classic one. */
        automatic: boolean;
        /** The classic runtime's element and fragment expressions, when not React's. */
        factory: string | null;
        fragment: string | null;
        /** esbuild's own `jsxFragment` as a primitive constant (`0`, `"frag"`, `null`), which it allows. */
        fragmentConstant: {
            value: null | boolean | number | string;
        } | null;
        /** The automatic runtime's package, when not `react`. */
        importSource: string | null;
        /** The automatic runtime's development variant (`jsxDEV`, with source locations). */
        development: boolean;
    };
    /**
     * esbuild's unused-import flags (TSConfig.UnusedImportFlags). KeepValues
     * (`preserveValueImports`, `verbatimModuleSyntax`): a value import stays
     * though unused. KeepStmt (`verbatimModuleSyntax`, `importsNotUsedAsValues`
     * `preserve` or `error`): an import statement stays, as `import "x"`, though
     * nothing of it is left; without it, one left with an empty clause
     * (`import {} from "x"`, every specifier a type) goes.
     */
    keepValues: boolean;
    keepStatements: boolean;
    /** `alwaysStrict` (else `strict`): `"use strict"` begins CommonJS and IIFE output. */
    alwaysStrict: boolean;
    /**
     * `experimentalDecorators`, for TypeScript (`ts`, `tsx`) files: their
     * decorators are TypeScript's legacy ones, which esbuild lowers to
     * __decorateClass calls in tsc's order. JavaScript files keep theirs.
     */
    experimentalDecorators: boolean;
    /**
     * `useDefineForClassFields` false (or a `target` below es2022 that implies
     * it), for TypeScript files: a class's fields are assigned in its
     * constructor (static ones after it), not defined, and one without an
     * initializer goes. JavaScript files keep theirs defined.
     */
    assignClassFields: boolean;
    /** What esbuild warns about the tsconfig, word for word. */
    warnings: string[];
}
/** A tsconfig field the engine cannot honour; its message names the field. */
export declare class TsconfigRefusal extends Error {
}
type Call = 'transform' | 'build';
/**
 * The settings `inputs` describe, as esbuild 0.24 would apply them to a
 * `call` (a transform or a build). Throws a TsconfigRefusal naming the
 * field for what the engines cannot do, and an Error for what esbuild
 * refuses itself (an invalid factory, a tsconfig that is not JSON).
 */
export declare function resolveTsSettings(inputs: TsconfigInputs, call: Call): TsSettings;
export {};
//# sourceMappingURL=tsconfig-raw.d.ts.map