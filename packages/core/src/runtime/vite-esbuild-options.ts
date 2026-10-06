/**
 * vite-esbuild-options.ts — what Vite's esbuild plugin (`vite:esbuild`, the
 * same in Vite 5.4, 6.4 and 7.3: `esbuildPlugin` and `transformWithEsbuild`
 * in vite/dist/node) passes esbuild for a module in `vite` (serve mode), for
 * the built-in Vite dev server to pass its transform:
 *
 * - `config.esbuild` as Vite 7.3's resolveConfig makes it: vite.config's
 *   `esbuild`, then what the project's plugins' config hooks merge into it
 *   (@vitejs/plugin-react, @preact/preset-vite), over `jsxDev: true`,
 *   `charset: 'utf8'` and `legalComments: 'none'`; `esbuild: false` turns
 *   the plugin off. (Vite 5.4 and 6.4 set charset in the plugin and leave
 *   legal comments in: neither changes what a module does.)
 * - the plugin's options: `target: 'esnext'`, the config's options over
 *   it, no minification, `keepNames` and `treeShaking` off, `supported`
 *   with `import()` and `import.meta` kept; `jsxInject`, `include` and
 *   `exclude` are its own.
 * - per module, its tsconfig's eleven meaningful compiler options (a .ts or
 *   .tsx module only; found and read by tsconfck, runtime/tsconfck.ts), the
 *   config's `tsconfigRaw.compilerOptions` over them, `useDefineForClassFields`
 *   false where neither sets it nor `target`, and the tsconfig's JSX options
 *   dropped where the options set their own.
 *
 * Recorded against real Vite 7.3.6 (and 6.4.3 and 5.4.21 beside it) in
 * tests/fixtures/vite-esbuild-reference.json.
 */

import type { ParsedViteConfig } from './vite-config-parser.js';
import { isJsonRecord } from './jsonc.js';

/** The compiler options a tsconfig gives esbuild through Vite: what changes a module's output. */
export const MEANINGFUL_TSCONFIG_FIELDS = [
  'alwaysStrict', 'experimentalDecorators', 'importsNotUsedAsValues', 'jsx', 'jsxFactory', 'jsxFragmentFactory',
  'jsxImportSource', 'preserveValueImports', 'target', 'useDefineForClassFields', 'verbatimModuleSyntax',
] as const;

/** What Vite keeps supported whatever the target: `import()` and `import.meta` stay as written. */
export const DEFAULT_ESBUILD_SUPPORTED: Readonly<Record<string, boolean>> = Object.freeze({ 'dynamic-import': true, 'import-meta': true });

/** The modules the plugin transforms, by default: .ts, .mts, .tsx and .jsx, never .js. */
const DEFAULT_INCLUDE = /\.(m?ts|[jt]sx)$/;
const DEFAULT_EXCLUDE = /\.js$/;
/** Where `jsxInject` goes: .jsx and .tsx modules. */
const JSX_EXTENSIONS = /\.(?:j|t)sx\b/;

/** What the dev server knows of a project's vite.config for the esbuild plugin. */
export interface ViteEsbuildSettings {
  /** `config.esbuild` as resolveConfig makes it in serve mode, or false (the plugin off). */
  esbuild: Readonly<Record<string, unknown>> | false;
  /** Whether a vite.config was read: without one the dev server keeps its own JSX defaults (vite-dev-server.ts). */
  hasConfig: boolean;
  /** What was left out, each said once: values vite.config computes, settings a plugin makes that are not esbuild's. */
  unread: string[];
}

/** Whether `value` is ViteEsbuildSettings, as a session kept it across hibernation. */
export function isViteEsbuildSettings(value: unknown): value is ViteEsbuildSettings {
  if (!isJsonRecord(value)) return false;
  return (value.esbuild === false || isJsonRecord(value.esbuild)) && typeof value.hasConfig === 'boolean'
    && Array.isArray(value.unread) && value.unread.every((item) => typeof item === 'string');
}

/** The plugins whose config hooks set `esbuild`, and what each sets from its options. */
const PLUGIN_ESBUILD: Record<string, (options: Record<string, unknown>) => { esbuild?: Record<string, unknown>; note?: string }> = {
  // plugin-react 4.7: `jsxRuntime: 'classic'` → { jsx: 'transform' }, else the automatic runtime.
  '@vitejs/plugin-react': (options) => (options.jsxRuntime === 'classic'
    ? { esbuild: { jsx: 'transform' } }
    : { esbuild: { jsx: 'automatic', jsxImportSource: options.jsxImportSource } }),
  // plugin-react-swc turns Vite's esbuild off and compiles with SWC: its JSX settings, on esbuild here.
  '@vitejs/plugin-react-swc': (options) => ({
    esbuild: { jsx: 'automatic', jsxImportSource: options.jsxImportSource },
    note: '@vitejs/plugin-react-swc compiles TypeScript with SWC in Vite; the built-in dev server compiles it with esbuild\'s equivalent settings',
  }),
  // preset-vite 2.10 sets esbuild's JSX unless it runs Babel (a `babel` option).
  '@preact/preset-vite': (options) => ({
    esbuild: { jsx: 'automatic', jsxImportSource: options.jsxImportSource ?? 'preact' },
    ...(options.babel !== undefined
      ? { note: '@preact/preset-vite with a `babel` option compiles JSX with Babel in Vite; the built-in dev server compiles it with esbuild, as without one' }
      : {}),
  }),
};

/** Vite's mergeConfig on two values: objects merged key by key, arrays joined, an absent override kept out. */
function merge(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) && Array.isArray(override)) return [...base, ...override];
  if (isJsonRecord(base) && isJsonRecord(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) out[key] = merge(out[key], value);
    return out;
  }
  return override;
}


/**
 * `config.esbuild` as Vite 7's resolveConfig makes it for `vite` from a
 * vite.config read statically: its `esbuild`, then each known plugin's
 * contribution merged over it in the order Vite runs their config hooks
 * (all of these are `enforce: 'pre'`, so in the order listed), over Vite's
 * defaults (jsxDev, charset, legalComments). `config` null: no vite.config.
 */
export function viteEsbuildSettings(config: ParsedViteConfig | null): ViteEsbuildSettings {
  const unread = [...(config?.esbuildComputed ?? []).map((key) => `vite.config's ${key} is computed, and read only statically: left out`)];
  let esbuild: unknown = config?.esbuild === false ? false : (config?.esbuild ?? {});
  for (const call of config?.pluginCalls ?? []) {
    const contribute = PLUGIN_ESBUILD[call.specifier];
    if (!contribute) continue;
    for (const key of call.computed) unread.push(`${call.specifier}'s option ${key} is computed, and read only statically: left out`);
    const { esbuild: contribution, note } = contribute(call.options);
    if (note) unread.push(note);
    // A plugin's config hook merges over `esbuild: false` as over an object.
    if (contribution) esbuild = merge(esbuild === false ? {} : esbuild, contribution);
  }
  return {
    esbuild: esbuild === false ? false : { jsxDev: true, charset: 'utf8', legalComments: 'none', ...(esbuild as Record<string, unknown>) },
    hasConfig: config !== null,
    unread,
  };
}

/** The esbuild plugin's transform options, from `config.esbuild` (esbuildPlugin). */
export function viteEsbuildPluginOptions(esbuild: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { jsxInject: _jsxInject, include: _include, exclude: _exclude, ...rest } = esbuild;
  return {
    target: 'esnext',
    ...rest,
    minify: false,
    minifyIdentifiers: false,
    minifySyntax: false,
    minifyWhitespace: false,
    treeShaking: false,
    keepNames: false,
    supported: { ...DEFAULT_ESBUILD_SUPPORTED, ...(isJsonRecord(rest.supported) ? rest.supported : {}) },
  };
}

/** Whether the esbuild plugin transforms `id` with its default include and exclude. */
export function viteEsbuildTransforms(id: string): boolean {
  const path = id.replace(/[?#].*$/, '');
  return DEFAULT_INCLUDE.test(path) && !DEFAULT_EXCLUDE.test(path);
}

/** The loader Vite gives `filename`: by extension, .mjs and .cjs as js, .mts and .cts as ts. */
export function viteLoader(filename: string): string {
  const path = filename.replace(/[?#].*$/, '');
  const ext = path.slice(path.lastIndexOf('.') + 1);
  if (ext === 'cjs' || ext === 'mjs') return 'js';
  if (ext === 'cts' || ext === 'mts') return 'ts';
  return ext;
}

/**
 * The options transformWithEsbuild gives esbuild for `filename`: the
 * plugin's `options`, its loader, and a tsconfigRaw made of `tsconfig`'s
 * meaningful compiler options (read only for a ts or tsx loader) under the
 * options' own `tsconfigRaw`, as Vite makes it.
 */
export function viteTransformOptions(
  filename: string,
  options: Readonly<Record<string, unknown>>,
  tsconfigCompilerOptions: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const loader = typeof options.loader === 'string' ? options.loader : viteLoader(filename);
  let tsconfigRaw = options.tsconfigRaw;
  if (typeof tsconfigRaw !== 'string') {
    const fromFile: Record<string, unknown> = {};
    if ((loader === 'ts' || loader === 'tsx') && tsconfigCompilerOptions) {
      for (const field of MEANINGFUL_TSCONFIG_FIELDS) if (field in tsconfigCompilerOptions) fromFile[field] = tsconfigCompilerOptions[field];
    }
    const raw = isJsonRecord(tsconfigRaw) ? tsconfigRaw : {};
    const compilerOptions: Record<string, unknown> = { ...fromFile, ...(isJsonRecord(raw.compilerOptions) ? raw.compilerOptions : {}) };
    if (compilerOptions.useDefineForClassFields === undefined && compilerOptions.target === undefined) compilerOptions.useDefineForClassFields = false;
    if (options.jsx) compilerOptions.jsx = undefined;
    if (options.jsxFactory) compilerOptions.jsxFactory = undefined;
    if (options.jsxFragment) compilerOptions.jsxFragmentFactory = undefined;
    if (options.jsxImportSource) compilerOptions.jsxImportSource = undefined;
    tsconfigRaw = { ...raw, compilerOptions: Object.fromEntries(Object.entries(compilerOptions).filter(([, value]) => value !== undefined)) };
  }
  return { sourcemap: true, sourcefile: filename, ...options, loader, tsconfigRaw };
}

/** `code` with `jsxInject` before it, for a .jsx or .tsx module, as the plugin puts it. */
export function withJsxInject(code: string, id: string, jsxInject: unknown): string {
  return typeof jsxInject === 'string' && jsxInject && JSX_EXTENSIONS.test(id) ? `${jsxInject};${code}` : code;
}
