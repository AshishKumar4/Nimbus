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
 * fragment only to the classic one.
 *
 * Every other field is honoured where the engines can produce esbuild's
 * output, refused by name where they cannot, and ignored where esbuild
 * ignores it (resolveTsSettings says which, and why; REFUSED, the reasons).
 * A refusal names its field, and comes only where the field would change
 * the output: `experimentalDecorators` for a TypeScript file with a
 * decorator, `useDefineForClassFields: false` (or a `target` that implies
 * it) for a TypeScript class with a public field. Those two the engines
 * refuse as they meet such a file (TsSettings.refuse).
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
        /** The automatic runtime's package, when not `react`. */
        importSource: string | null;
        /** The automatic runtime's development variant (`jsxDEV`, with source locations). */
        development: boolean;
    };
    /** `verbatimModuleSyntax` or `preserveValueImports`: an import is dropped only when it is type-only. */
    preserveValueImports: boolean;
    /** `alwaysStrict` (else `strict`): `"use strict"` begins CommonJS and IIFE output. */
    alwaysStrict: boolean;
    /**
     * What a TypeScript (`ts`, `tsx`) file may not contain under this tsconfig,
     * as the refusal naming its field: esbuild compiles it differently, and the
     * engines cannot. JavaScript files are compiled the same either way.
     */
    refuse: {
        /** `experimentalDecorators`: any decorator (esbuild lowers it to __decorateClass calls). */
        decorators: string | null;
        /** `useDefineForClassFields` false: a class with a public or static field (esbuild assigns it in the constructor). */
        classFields: string | null;
    };
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