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
export class TsconfigRefusal extends Error {}

type Call = 'transform' | 'build';

/**
 * Each compilerOptions field esbuild reads, and what Nimbus does with it.
 * Refused fields refuse only for the values whose effect the engines cannot
 * produce; the reason is part of the message.
 */
const REFUSED = {
  experimentalDecorators: 'TypeScript\'s experimental decorators compile to calls of runtime helpers that Nimbus does not serve',
  useDefineForClassFields: 'Nimbus\'s engines keep class fields as fields, where useDefineForClassFields false makes them constructor assignments',
  importsNotUsedAsValues: 'keeping an unused import as a bare `import "x"` is not something Nimbus\'s engines do',
} as const;

/** esbuild's js_ast.IsIdentifier for one part of a JSX member expression. */
function isIdentifier(text: string): boolean {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(text);
}

/** esbuild's parseMemberExpressionForJSX: `a.b.c`, or null (with esbuild's warning) when it is not one. */
function memberExpression(text: string, warnings: string[]): string | null {
  if (text === '') return null;
  if (text.split('.').every(isIdentifier)) return text;
  warnings.push(`Invalid JSX member expression: ${JSON.stringify(text)}`);
  return null;
}

/**
 * JSON as esbuild reads a tsconfig: comments and trailing commas allowed.
 * Strings are walked so neither is looked for inside one.
 */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  // A comma before a closing bracket, outside strings: rewrite the text with
  // strings blanked to find them, then drop them from the real text.
  const blanked = out.replace(/"(?:[^"\\]|\\.)*"/g, (s) => '"' + ' '.repeat(s.length - 2) + '"');
  let result = '';
  for (let i = 0; i < out.length; i++) {
    if (blanked[i] === ',' && /^\s*[}\]]/.test(blanked.slice(i + 1))) continue;
    result += out[i];
  }
  return JSON.parse(result);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
export function resolveTsSettings(inputs: TsconfigInputs, call: Call): TsSettings {
  const warnings: string[] = [];
  const jsxMode = inputs.jsx ?? 'transform';
  if (jsxMode !== 'transform' && jsxMode !== 'automatic' && jsxMode !== 'preserve') {
    throw new Error(`Invalid JSX mode: ${JSON.stringify(jsxMode)}`);
  }
  // esbuild's own options first (validateJSXExpr: an invalid one is an error).
  const ownExpression = (text: string | undefined, what: string) => {
    if (text === undefined || text === '') return null;
    if (!text.split('.').every(isIdentifier)) throw new Error(`Invalid JSX ${what}: ${JSON.stringify(text)}`);
    return text;
  };
  const jsx: TsSettings['jsx'] = {
    preserve: jsxMode === 'preserve',
    automatic: jsxMode === 'automatic',
    factory: ownExpression(inputs.jsxFactory, 'factory'),
    fragment: ownExpression(inputs.jsxFragment, 'fragment'),
    importSource: inputs.jsxImportSource || null,
    development: inputs.jsxDev === true,
  };
  const settings: TsSettings = {
    jsx, preserveValueImports: false, alwaysStrict: false, refuse: { decorators: null, classFields: null }, warnings,
  };

  const raw = inputs.tsconfigRaw;
  if (raw === undefined || raw === '') return finish(settings);
  let config: unknown;
  if (typeof raw === 'string') {
    try {
      config = parseJsonc(raw);
    } catch (error) {
      throw new Error(`tsconfigRaw is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    config = raw;
  }
  if (!isObject(config)) return finish(settings);

  for (const key of Object.keys(config)) {
    if (COMPILER_OPTION_KEYS.includes(key)) {
      warnings.push(`Expected the ${JSON.stringify(key)} option to be nested inside a "compilerOptions" object`);
      break;
    }
  }
  // `extends` names a file: esbuild's transform never reads one, and its
  // build could not (esbuild-wasm has no file system: the build failed).
  if (call === 'build' && config.extends !== undefined) {
    throw new TsconfigRefusal('tsconfigRaw "extends" is not supported: a build reads no tsconfig file it names');
  }

  const options = config.compilerOptions;
  if (!isObject(options)) return finish(settings);
  const string = (key: string) => (typeof options[key] === 'string' ? options[key] as string : undefined);
  const boolean = (key: string) => (typeof options[key] === 'boolean' ? options[key] as boolean : undefined);

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
  if (factory !== undefined) jsx.factory = memberExpression(factory, warnings) ?? jsx.factory;
  const fragment = string('jsxFragmentFactory');
  if (fragment !== undefined) jsx.fragment = memberExpression(fragment, warnings) ?? jsx.fragment;
  const importSource = string('jsxImportSource');
  if (importSource !== undefined) jsx.importSource = importSource;

  // Decorators: off is what the engines do; on lowers to helper calls they cannot serve.
  if (boolean('experimentalDecorators') === true) {
    settings.refuse.decorators =
      `tsconfigRaw compilerOptions.experimentalDecorators true is not supported for a TypeScript file with decorators: ${REFUSED.experimentalDecorators}`;
  }

  // Class fields: `useDefineForClassFields`, else what `target` implies for it
  // (below es2022, false); unrecognized targets are ignored with esbuild's warning.
  const target = string('target');
  let targetBelowEs2022: boolean | undefined;
  if (target !== undefined) {
    const lower = target.toLowerCase();
    if (/^(es3|es5|es6|es2015|es2016|es2017|es2018|es2019|es2020|es2021)$/.test(lower)) targetBelowEs2022 = true;
    else if (/^(es2022|es2023|es2024|esnext)$/.test(lower)) targetBelowEs2022 = false;
    else warnings.push(`Unrecognized target environment ${JSON.stringify(target)}`);
  }
  const useDefine = boolean('useDefineForClassFields');
  if (useDefine === false) {
    settings.refuse.classFields =
      `tsconfigRaw compilerOptions.useDefineForClassFields false is not supported for a TypeScript class with fields: ${REFUSED.useDefineForClassFields}`;
  }
  if (useDefine === undefined && targetBelowEs2022 === true) {
    settings.refuse.classFields =
      `tsconfigRaw compilerOptions.target ${JSON.stringify(target)} is not supported for a TypeScript class with fields: below es2022 it makes ` +
      `useDefineForClassFields false, and ${REFUSED.useDefineForClassFields}; set "useDefineForClassFields": true, or a target of es2022 or later`;
  }

  // Imports: verbatimModuleSyntax and preserveValueImports keep every value
  // import; importsNotUsedAsValues "preserve" and "error" keep unused ones bare.
  if (boolean('verbatimModuleSyntax') === true || boolean('preserveValueImports') === true) settings.preserveValueImports = true;
  const notUsed = string('importsNotUsedAsValues');
  if (notUsed === 'preserve' || notUsed === 'error') {
    throw new TsconfigRefusal(`tsconfigRaw compilerOptions.importsNotUsedAsValues ${JSON.stringify(notUsed)} is not supported: ${REFUSED.importsNotUsedAsValues}`);
  }
  if (notUsed !== undefined && notUsed !== 'remove') warnings.push(`Invalid value ${JSON.stringify(notUsed)} for "importsNotUsedAsValues"`);

  // Strictness: alwaysStrict, else strict.
  settings.alwaysStrict = boolean('alwaysStrict') ?? boolean('strict') ?? false;

  // baseUrl and paths: a transform resolves nothing, and a build's every
  // import is resolved by the caller's plugin, so esbuild never applied them
  // either. Every other field esbuild ignores too.
  return finish(settings);
}

/** What the settings leave out: development and an import source only matter to the automatic runtime. */
function finish(settings: TsSettings): TsSettings {
  if (!settings.jsx.automatic) {
    settings.jsx.development = false;
    settings.jsx.importSource = null;
  }
  return settings;
}
