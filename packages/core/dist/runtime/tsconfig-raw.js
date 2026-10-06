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
import { isJsonRecord, jsoncToJson } from './jsonc.js';
/** A tsconfig field the engine cannot honour; its message names the field. */
export class TsconfigRefusal extends Error {
}
/** esbuild's js_lexer.Keywords: none may begin a JSX expression but `null`, `this` and `import.meta`. */
const KEYWORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
    'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
    'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);
/**
 * esbuild's ParseDefineExprOrJSON, as validateJSXExpr reads its own
 * `jsxFactory` and `jsxFragment`: a property chain whose first part is no
 * keyword but `null`, `this` or `import` (of `import.meta`), else a JSON
 * primitive (single quotes allowed, as esbuild's JSON reader recovers from
 * them), which only a fragment may be. Null when it is neither.
 */
function jsxExpression(text) {
    const parts = text.split('.');
    const first = parts[0];
    if (parts.every(isIdentifier) && (!KEYWORDS.has(first) || first === 'null' || first === 'this' || (first === 'import' && parts[1] === 'meta'))) {
        return { chain: text };
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        const single = /^\s*'((?:[^'\\]|\\.)*)'\s*$/.exec(text);
        if (!single)
            return null;
        try {
            value = JSON.parse(`"${single[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
        }
        catch {
            return null;
        }
    }
    return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' ? { constant: value } : null;
}
/** esbuild's js_ast.IsIdentifier for one part of a JSX member expression. */
function isIdentifier(text) {
    return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(text);
}
/** esbuild's parseMemberExpressionForJSX: `a.b.c`, or null (with esbuild's warning) when it is not one. */
function memberExpression(text, warnings) {
    if (text === '')
        return null;
    if (text.split('.').every(isIdentifier))
        return text;
    warnings.push(`Invalid JSX member expression: ${JSON.stringify(text)}`);
    return null;
}
/** The keys esbuild warns about when they sit beside, not inside, compilerOptions. */
const COMPILER_OPTION_KEYS = [
    'alwaysStrict', 'baseUrl', 'experimentalDecorators', 'importsNotUsedAsValues', 'jsx', 'jsxFactory',
    'jsxFragmentFactory', 'jsxImportSource', 'paths', 'preserveValueImports', 'strict', 'target',
    'useDefineForClassFields', 'verbatimModuleSyntax',
];
/**
 * The settings `inputs` describe, as esbuild 0.24 would apply them to a
 * `call` (a transform or a build). Throws a TsconfigRefusal naming the
 * field for what the engines cannot do, and an Error for what esbuild
 * refuses itself (an invalid factory, a tsconfig that is not JSON).
 */
export function resolveTsSettings(inputs, call) {
    const warnings = [];
    const jsxMode = inputs.jsx ?? 'transform';
    if (jsxMode !== 'transform' && jsxMode !== 'automatic' && jsxMode !== 'preserve') {
        throw new Error(`Invalid JSX mode: ${JSON.stringify(jsxMode)}`);
    }
    // esbuild's own options first (validateJSXExpr: an invalid one is an error).
    const own = (text, what) => {
        if (text === undefined || text === '')
            return null;
        const expression = jsxExpression(text);
        if (!expression || ('constant' in expression && what !== 'fragment'))
            throw new Error(`Invalid JSX ${what}: ${JSON.stringify(text)}`);
        // A fragment named `null` is the constant: what esbuild prints for it.
        if (what === 'fragment' && 'chain' in expression && expression.chain === 'null')
            return { constant: null };
        return expression;
    };
    const ownFactory = own(inputs.jsxFactory, 'factory');
    const ownFragment = own(inputs.jsxFragment, 'fragment');
    const jsx = {
        preserve: jsxMode === 'preserve',
        automatic: jsxMode === 'automatic',
        factory: ownFactory && 'chain' in ownFactory ? ownFactory.chain : null,
        fragment: ownFragment && 'chain' in ownFragment ? ownFragment.chain : null,
        fragmentConstant: ownFragment && 'constant' in ownFragment ? { value: ownFragment.constant } : null,
        importSource: inputs.jsxImportSource || null,
        development: inputs.jsxDev === true,
    };
    const settings = {
        jsx, keepValues: false, keepStatements: false, alwaysStrict: false, experimentalDecorators: false, assignClassFields: false, warnings,
    };
    const raw = inputs.tsconfigRaw;
    if (raw === undefined || raw === '')
        return finish(settings);
    let config;
    if (typeof raw === 'string') {
        try {
            config = JSON.parse(jsoncToJson(raw, 'esbuild'));
        }
        catch (error) {
            throw new Error(`tsconfigRaw is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    else {
        config = raw;
    }
    if (!isJsonRecord(config))
        return finish(settings);
    for (const key of Object.keys(config)) {
        if (COMPILER_OPTION_KEYS.includes(key)) {
            warnings.push(`Expected the ${JSON.stringify(key)} option to be nested inside a "compilerOptions" object`);
            break;
        }
    }
    // `extends` names files (a string, or an array's strings): esbuild's
    // transform never reads one, and its build could not (esbuild-wasm has no
    // file system: the build failed). Anything else names none (`[]`, `null`).
    const extendsFiles = typeof config.extends === 'string' || (Array.isArray(config.extends) && config.extends.some((e) => typeof e === 'string'));
    if (call === 'build' && extendsFiles) {
        throw new TsconfigRefusal('tsconfigRaw "extends" is not supported: a build reads no tsconfig file it names');
    }
    const options = config.compilerOptions;
    if (!isJsonRecord(options))
        return finish(settings);
    const string = (key) => (typeof options[key] === 'string' ? options[key] : undefined);
    const boolean = (key) => (typeof options[key] === 'boolean' ? options[key] : undefined);
    // JSX: esbuild's TSConfigJSX.ApplyTo, over its own options.
    switch (string('jsx')?.toLowerCase()) {
        case 'react':
            jsx.automatic = false;
            jsx.development = false;
            break;
        case 'react-jsx':
            jsx.automatic = true;
            break;
        case 'react-jsxdev':
            jsx.automatic = true;
            jsx.development = true;
            break;
        default:
            // "preserve", "react-native" and unknown values: deliberately ignored, as esbuild does.
            break;
    }
    const factory = string('jsxFactory');
    if (factory !== undefined)
        jsx.factory = memberExpression(factory, warnings) ?? jsx.factory;
    const fragmentFactory = string('jsxFragmentFactory');
    const fragment = fragmentFactory === undefined ? null : memberExpression(fragmentFactory, warnings);
    if (fragment !== null) {
        jsx.fragment = fragment;
        jsx.fragmentConstant = null;
    }
    const importSource = string('jsxImportSource');
    if (importSource !== undefined)
        jsx.importSource = importSource;
    settings.experimentalDecorators = boolean('experimentalDecorators') === true;
    // Class fields: `useDefineForClassFields`, else what `target` implies for it
    // (below es2022, false); unrecognized targets are ignored with esbuild's warning.
    const target = string('target');
    let targetBelowEs2022;
    if (target !== undefined) {
        const lower = target.toLowerCase();
        if (/^(es3|es5|es6|es2015|es2016|es2017|es2018|es2019|es2020|es2021)$/.test(lower))
            targetBelowEs2022 = true;
        else if (/^(es2022|es2023|es2024|esnext)$/.test(lower))
            targetBelowEs2022 = false;
        else
            warnings.push(`Unrecognized target environment ${JSON.stringify(target)}`);
    }
    settings.assignClassFields = (boolean('useDefineForClassFields') ?? !targetBelowEs2022) === false;
    // Imports: esbuild's UnusedImportFlags, KeepStmt and KeepValues apart.
    const notUsed = string('importsNotUsedAsValues');
    if (notUsed !== undefined && notUsed !== 'remove' && notUsed !== 'preserve' && notUsed !== 'error') {
        warnings.push(`Invalid value ${JSON.stringify(notUsed)} for "importsNotUsedAsValues"`);
    }
    if (boolean('verbatimModuleSyntax') === true) {
        settings.keepValues = true;
        settings.keepStatements = true;
    }
    else {
        settings.keepValues = boolean('preserveValueImports') === true;
        settings.keepStatements = notUsed === 'preserve' || notUsed === 'error';
    }
    // Strictness: alwaysStrict, else strict.
    settings.alwaysStrict = boolean('alwaysStrict') ?? boolean('strict') ?? false;
    // baseUrl and paths: a transform resolves nothing, and a build's every
    // import is resolved by the caller's plugin, so esbuild never applied them
    // either. Every other field esbuild ignores too.
    return finish(settings);
}
/** What the settings leave out: development and an import source only matter to the automatic runtime. */
function finish(settings) {
    if (!settings.jsx.automatic) {
        settings.jsx.development = false;
        settings.jsx.importSource = null;
    }
    return settings;
}
