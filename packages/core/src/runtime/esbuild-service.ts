/**
 * EsbuildService — TypeScript/JSX transform + bundling.
 *
 * A host whose isolate is memory-constrained passes a `transformHost` and a
 * `buildHost` so both run in another isolate: the session's transforms run in
 * its transform facet on Nimbus's Oxc build (oxc-transform.ts, which keeps
 * esbuild's transform contract), its builds in the esbuild facet. Without
 * them, esbuild-wasm runs both here; its linear memory starts at ~28 MiB,
 * grows to fit the working set and cannot shrink. build()'s VFS resolver
 * plugin always runs here, over this service's view.
 */

import type { Awaitable } from '../vfs/vfs.js';
import { ESBUILD_FACET_RUNTIME_SOURCE, TRANSFORM_FACET_RUNTIME_SOURCE } from './compiled-bodies.generated.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';
import { errorText } from '../_shared/error-text.js';
import { typescriptLoader } from '../_shared/typescript-specifiers.js';
import { rewriteDynamicImports } from './dynamic-import-rewrite.js';
import { packageNameFromSpecifier } from './barrel-detect.js';
import { bundlerConditions, createBundlerResolver } from './bundler-resolution.js';
import { lowerAsyncModule, lowerEsModule } from './async-module-lowering.js';
import { ES_MODULE_UNBOUND_NAMES, esModuleScopeTypeofs, type ModuleScope, type PackageType } from './module-format.js';
import type { StrippedTypeScript, TypeScriptStripOptions } from './typescript-strip.js';
import type { TypeScriptRefusal } from './typescript-refusal.js';
import { rewriteProvidedCommonJsModules } from './provided-packages.js';
import { withRecall } from '../vfs/recall.js';
import {
  VITE_ASSET_QUERY_SUFFIXES,
  splitImportQuery,
  viteAssetLoader,
  type ViteAssetLoaderKind,
} from './vite-assets.js';

/**
 * Bundler version tag. BUMP THIS whenever bundling semantics change —
 * the esbuild plugin's resolver logic, the shared-externals rules, the
 * post-processing pipeline, or anything that would invalidate cached
 * pre-bundles. The version is stored in pkg_esm_bundles.bundle_hash and
 * checked on read; cache entries with a different version are treated
 * as missing and rebuilt from scratch.
 *
 * History:
 *   v1 — initial pre-bundling
 *   v2 — shared React externals, CJS named exports
 *   v3 — Node subpath imports (#foo) support for vfile/unified ecosystem
 *   v4 — legacy flat-subpath resolution (pkg/sub without exports field);
 *        CDN fallback wrapper no longer crashes on modules without default
 *   v5 — normalize `../` segments in joined entry paths (react-remove-scroll-bar
 *        style: nested package.json with "module": "../dist/es2015/foo.js")
 *   v6 — externals enforced via plugin onResolve only (top-level `external:`
 *        dropped). Fixes dual-React-instance bug where jsx-runtime and
 *        react-dom/client were inlining their own copy of react because
 *        esbuild's entry-point external check rejected the externals when
 *        passed at the top level. v5 cache entries are wrong (contain
 *        embedded react copies) and must be invalidated.
 *   v7 — barrel-package bundles include a named-import signature in
 *        pkg_esm_bundles.input_hash. Prevents reusing a lucide-react
 *        bundle synthesized for one icon set after user source imports
 *        additional icons.
 *   v8 — pkg_esm_bundles now stores RAW esbuild output (base-independent);
 *        the module-URL rewrite that used to be baked in is applied per
 *        request at serve time so one bundle serves every mount base. v7
 *        rows hold post-rewrite text and must be re-bundled. user_module_
 *        transforms is likewise re-keyed by mount base.
 *   v12 — pre-bundles built by rolldown in the build facet
 *        (runtime/prebundle-slice.ts) instead of esbuild-wasm; v11 rows hold
 *        esbuild's output.
 */
export const BUNDLER_VERSION = 'v12';

// ── Shared-runtime externals ────────────────────────────────────────────

/**
 * Returns the list of specifiers that must be marked `external` when bundling
 * `specifier` so that React / React-DOM / Scheduler share a single instance
 * across all /@modules/ bundles.
 *
 * Why: React uses an internal module-scoped singleton
 * (`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`) for current dispatcher,
 * owner, etc. If two bundles each contain their own embedded React, they each
 * have their own singleton, and `createRoot` from one bundle sees JSX elements
 * created by the other as "alien" — silent render failure (root stays empty).
 *
 * The fix: when bundling react-dom/*, mark react/* and scheduler as external.
 * The bundler leaves `import {...} from "react"` in the output; the browser
 * then fetches /preview/@modules/react, which is the SAME URL the jsx-runtime
 * bundle imports — so both react-dom and jsx-runtime share ONE React instance.
 *
 * Similarly for react/jsx-runtime and react/jsx-dev-runtime (they must share
 * react's internals), we externalize `react` (but not `scheduler` — jsx-runtime
 * doesn't need it).
 */
export function getSharedRuntimeExternals(specifier: string): string[] {
  // react: the canonical bundle. No externals — it's the source of truth.
  if (specifier === 'react') return [];

  // react/jsx-runtime, react/jsx-dev-runtime: import from react's
  // ReactSharedInternals to use the dispatcher. Externalize `react` so
  // the jsx-runtime bundle is just the JSX helpers (~5 KiB) sharing
  // ONE React instance via the browser's module loader.
  if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
    return ['react'];
  }
  // Other react/* subpaths (e.g., react/server) — externalize react.
  if (specifier.startsWith('react/')) {
    return ['react'];
  }

  // EVERYTHING ELSE — react-dom, framer-motion, lucide-react, zustand,
  // @radix-ui/*, react-router, etc. — must share react's singleton. If any
  // of these embeds its own React copy, elements tagged by that copy get
  // rejected as "alien" by the createRoot from the OTHER React copy
  // (silent render fail / "Objects are not valid as a React child" with
  // $$typeof spelled out). Externalize the entire React runtime.
  //
  // We DO NOT use `react/*` glob here because that has historically tripped
  // esbuild's entry-point check. Instead we list the specific subpath
  // imports React's ecosystem actually emits: jsx-runtime + jsx-dev-runtime.
  // (react-dom subpaths are handled below by 'react-dom/*'.)
  //
  // Filter out patterns that match the spec being bundled — when
  // bundling 'react-dom', drop 'react-dom' / 'react-dom/*' from the list
  // so the entry can be bundled.
  const all = [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/*',
    'scheduler',
  ];
  // Determine the package name for the spec being bundled (handles
  // scoped packages and subpaths: 'react-dom/client' → 'react-dom').
  const specPkg = packageNameFromSpecifier(specifier);

  return all.filter((pat) => {
    if (pat === specifier) return false;
    if (pat.endsWith('/*')) {
      const prefix = pat.slice(0, -1); // e.g. 'react-dom/'
      const pkgName = pat.slice(0, -2); // e.g. 'react-dom'
      if (specifier.startsWith(prefix)) return false;
      if (specifier === pkgName) return false;
      if (specPkg === pkgName) return false;
    } else {
      // Plain (non-glob) external. Drop if the spec being bundled is
      // a subpath of this external's package.
      if (specPkg === pat) return false;
    }
    return true;
  });
}

// ── The in-isolate engine ───────────────────────────────────────────────
//
// Nimbus runs no esbuild in a session's isolate: transforms go to the
// transform facet (Oxc), builds to the build facet (rolldown), and esbuild
// itself only to the esbuild facet, which loads esbuild-wasm from staged
// assets when it is needed. An EsbuildService given no host runs the call
// on an engine its caller supplies (EsbuildServiceOptions.engine): a test,
// or a tool outside a Worker. This module imports no part of esbuild-wasm,
// so the host Worker bundles none of it.
import type * as esbuild from 'esbuild-wasm/esm/browser.js';

/** What an in-isolate engine offers: esbuild's transform and build, ready to call. */
export type EsbuildEngine = Pick<typeof esbuild, 'transform' | 'build'>;

// ── Types ───────────────────────────────────────────────────────────────

export interface EsbuildTransformOptions {
  loader?: 'ts' | 'tsx' | 'jsx' | 'js' | 'css' | 'json';
  format?: 'esm' | 'cjs' | 'iife';
  target?: string;
  sourcemap?: boolean | 'inline' | 'external';
  minify?: boolean;
  jsx?: 'transform' | 'preserve' | 'automatic';
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  jsxDev?: boolean;
  /** A tsconfig's text or object, read as esbuild 0.24 reads it (runtime/tsconfig-raw.ts). */
  tsconfigRaw?: string | esbuild.TsconfigRaw;
  define?: Record<string, string>;
  /**
   * esbuild's `supported`, over what the options below decide: Vite's dev
   * server keeps `import()` and `import.meta` as written (`{ 'dynamic-import':
   * true, 'import-meta': true }`), where an ES module transform otherwise
   * empties `import.meta` and makes `import()` a `require`.
   */
  supported?: Record<string, boolean>;
  /** The module's name in diagnostics, source maps and jsxDEV's `fileName`. */
  sourcefile?: string;
  /**
   * The URL of the module being transformed, when its dynamic `import()`
   * calls are the process's (dynamic-import-rewrite.ts): esbuild keeps them
   * as written and each becomes a call of the process's ESM loader with this
   * parent. Unset, esbuild lowers them to `require`.
   */
  dynamicImportParent?: string;
  /** Only the dynamic `import()` rewrite: the code is already CommonJS. */
  rewriteOnly?: boolean;
  /**
   * TypeScript Node runs: its types stripped as Node strips them, then as
   * Node's format for it (by its extension, `packageType`, else its stripped
   * syntax) an ES module lowered in Node's scope or CommonJS whose import()
   * is routed (typescript-strip.ts). `sourcefile` names it; dynamicImportParent
   * and moduleMetadata are read too.
   */
  stripTypes?: TypeScriptStripOptions;
  packageType?: PackageType;
  /** Only the strip: the stripped code, `esModule` where Node runs it as an ES module. */
  stripOnly?: true;
  /** Bind compiler-produced import.meta references to the wrapper module. */
  moduleMetadata?: boolean;
  /**
   * The code is an ES module, lowered to CommonJS in this runtime's scope
   * at dynamicImportParent (async-module-lowering.ts lowerEsModule), its
   * result's map the EsModuleMap; where the engine lowers it instead,
   * moduleMetadata and define are read too.
   */
  esModule?: ModuleScope;
}

export interface TransformResult {
  code: string;
  map: string;
  warnings: { text: string; location?: esbuild.Location | null }[];
  /** An ES module this lowered, in this runtime's scope: its frames are an ES module's, and Node's its typeofs. */
  esModule?: ModuleScope;
}
/**
 * One emitted output. `bytes` is authoritative (UTF-8 fidelity for the
 * `file`-loader assets `viteAssets` emits); `contents` is the lazy decoded
 * view, memoized exactly like esbuild's own `OutputFile.text`.
 */
export interface BuildOutputFile {
  path: string;
  bytes: Uint8Array;
  readonly contents: string;
}

export interface BuildResult {
  outputFiles: BuildOutputFile[];
  /** esbuild's diagnostics, with their notes; never \`detail\` (serializableMessage). */
  errors: esbuild.Message[];
  warnings: esbuild.Message[];
  /** esbuild metafile — populated because build() always enables it so
   *  callers can identify entry-point outputs (`entryPoint`, `cssBundle`)
   *  instead of guessing from output ordering. */
  metafile?: esbuild.Metafile;
}

const __outputDecoder = new TextDecoder();

type EsbuildTransformApi = Pick<typeof esbuild, 'transform'>;
type EsbuildBuildApi = Pick<typeof esbuild, 'build'>;

/**
 * `lower` is async-module-lowering.ts's `lowerAsyncModule`, passed in because
 * this function is serialized into the transform facet.
 */
async function transformWithEsbuild(
  esbuildApi: EsbuildTransformApi,
  code: string,
  options: EsbuildTransformOptions | undefined,
  lower: (esm: string) => string,
): Promise<TransformResult> {
  // What esbuild may keep as written: `import()` where the process's loader
  // takes it, `import.meta` where it is bound; the caller's `supported` over
  // that. (No helper function: this one is serialized into the transform
  // facet, where a bundler's name-keeping wrapper is not defined.)
  const supported = {
    'dynamic-import': options?.dynamicImportParent !== undefined,
    'import-meta': options?.moduleMetadata === true,
    ...options?.supported,
  };
  const format = options?.format || 'esm';
  const loader = options?.loader || 'ts';

  if (format === 'cjs') {
    try {
      const direct = await esbuildApi.transform(code, {
        loader,
        format,
        target: options?.target || 'esnext',
        sourcemap: options?.sourcemap ?? false,
        minify: options?.minify ?? false,
        jsx: options?.jsx,
        jsxFactory: options?.jsxFactory,
        jsxFragment: options?.jsxFragment,
        jsxImportSource: options?.jsxImportSource,
        jsxDev: options?.jsxDev,
        tsconfigRaw: options?.tsconfigRaw,
        define: options?.define,
        supported,
        sourcefile: options?.sourcefile,
      });
      return {
        code: direct.code,
        map: direct.map || '',
        warnings: direct.warnings?.map((warning) => ({
          text: warning.text,
          location: warning.location,
        })) || [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/top-level await.*not supported.*cjs/i.test(message)) throw error;
    }
    // A hashbang is valid only at the start of a script. The TLA fallback
    // moves the body into an async function, so keep its line as a comment
    // before either fallback pass (Vite bin/vite.js imported by Vinext).
    if (code.startsWith('#!')) code = '//' + code.slice(2);

    // esbuild emits no CommonJS for top-level await: emit the module as ESM
    // and lower its declarations around an async function body.
    const esm = await esbuildApi.transform(code, {
      loader,
      format: 'esm',
      target: options?.target || 'esnext',
      sourcemap: false,
      minify: false,
      jsx: options?.jsx,
      jsxFactory: options?.jsxFactory,
      jsxFragment: options?.jsxFragment,
      jsxImportSource: options?.jsxImportSource,
      jsxDev: options?.jsxDev,
      tsconfigRaw: options?.tsconfigRaw,
      define: options?.define,
      supported,
      sourcefile: options?.sourcefile,
    });
    return {
      code: lower(esm.code),
      map: '',
      warnings: esm.warnings?.map((warning) => ({
        text: warning.text,
        location: warning.location,
      })) || [],
    };
  }

  const result = await esbuildApi.transform(code, {
    loader,
    format,
    target: options?.target || 'esnext',
    sourcemap: options?.sourcemap ?? false,
    minify: options?.minify ?? false,
    jsx: options?.jsx,
    jsxFactory: options?.jsxFactory,
    jsxFragment: options?.jsxFragment,
    jsxImportSource: options?.jsxImportSource,
    jsxDev: options?.jsxDev,
    tsconfigRaw: options?.tsconfigRaw,
    define: options?.define,
    supported,
    sourcefile: options?.sourcefile,
  });

  return {
    code: result.code,
    map: result.map || '',
    warnings: result.warnings?.map((warning) => ({
      text: warning.text,
      location: warning.location,
    })) || [],
  };
}

/**
 * What a transform request runs besides its engine: the functions the
 * transform facet's preamble installs (oxc-facet/preamble.ts), passed in
 * because runTransformRequest is serialized into the facet. Only the
 * transform facet strips TypeScript.
 */
export interface TransformRuntime {
  rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata?: boolean, routeImports?: boolean): string;
  lowerAsyncModule(esm: string): string;
  lowerEsModule(source: string, scope: ModuleScope, parentUrl: string): TransformResult;
  rewriteProvidedCommonJsModules(source: string): string;
  stripTypeScript?(code: string, filename: string, options: TypeScriptStripOptions, packageType: PackageType): Promise<StrippedTypeScript>;
}

/**
 * One transform request as a transform host runs it: esbuild (unless the
 * code is already CommonJS), then, for a module whose dynamic `import()` is
 * the process's, the rewrite that routes each one to the process's ESM loader.
 * `engine` is null only before esbuild is loaded, which a rewrite-only
 * request does not wait for.
 */
export async function runTransformRequest(
  engine: EsbuildTransformApi | (() => Promise<EsbuildTransformApi>) | null,
  code: string,
  options: EsbuildTransformOptions | undefined,
  runtime: TransformRuntime,
): Promise<TransformResult | { error: string; typescript: TypeScriptRefusal }> {
  const parent = options?.dynamicImportParent;
  if (options?.stripTypes) {
    if (runtime.stripTypeScript === undefined) throw new Error('a type strip where amaro is not loaded');
    const { stripTypes, packageType, stripOnly, ...rest } = options;
    const stripped = await runtime.stripTypeScript(code, rest.sourcefile ?? '', stripTypes, packageType ?? null);
    if ('refusal' in stripped) return { error: stripped.refusal.message, typescript: stripped.refusal };
    if (stripOnly) return { code: stripped.code, map: '', warnings: [], ...(stripped.format === 'module' ? { esModule: 'node' as const } : {}) };
    // JavaScript now: its bundled records of provided packages bound, as the session binds JavaScript's (preparedTransformSource).
    const javaScript = runtime.rewriteProvidedCommonJsModules(stripped.code);
    if (stripped.format === 'module') {
      const lowering: EsbuildTransformOptions = { ...rest, esModule: 'node' };
      try {
        return await runTransformRequest(engine, javaScript, lowering, runtime);
      } catch (e) {
        // Where the engine's stack runs out (oxc-transform.ts), the esbuild facet lowers the stripped code: it has no amaro.
        if (typeof e === 'object' && e !== null && Reflect.get(e, 'stackExhausted') === true) Reflect.set(e, 'retry', { code: javaScript, options: lowering });
        throw e;
      }
    }
    return { code: parent === undefined ? javaScript : runtime.rewriteDynamicImports(javaScript, parent), map: '', warnings: [] };
  }
  if (options?.rewriteOnly) {
    if (parent === undefined) throw new Error('a rewrite-only transform needs dynamicImportParent');
    return { code: runtime.rewriteDynamicImports(code, parent, options.moduleMetadata), map: '', warnings: [] };
  }
  if (options?.esModule) {
    if (parent === undefined) throw new Error('an ES module transform needs dynamicImportParent');
    try {
      return { ...runtime.lowerEsModule(code, options.esModule, parent), esModule: options.esModule };
    } catch (e) {
      // Nested past what a parse on this stack reaches (acorn, about 600
      // levels): the engine's CommonJS, which in the transform facet runs out
      // too and so goes to the esbuild facet, whose parser does not; the
      // session's define (requestOptions) keeps Node's scope.
      if (!(e instanceof RangeError)) throw e;
      const { esModule: scope, ...rest } = options;
      const compiled = await runTransformRequest(engine, code, { ...rest, loader: 'js', format: 'cjs', target: 'esnext' }, runtime);
      return { ...compiled as TransformResult, esModule: scope };
    }
  }
  const esbuildApi = typeof engine === 'function' ? await engine() : engine;
  if (esbuildApi === null) throw new Error('esbuild transform before esbuild is loaded');
  if (options?.moduleMetadata && parent !== undefined && code.includes('import')) {
    // CJS emit replaces import.meta with an empty object even when syntax
    // support is enabled. First erase TypeScript/JSX with the module format
    // preserved, bind metadata references, then lower declarations. Both
    // passes and import analysis stay in the transform facet.
    // No ESM emit in between: it wraps a cell that assigns module.exports
    // in __commonJS and exports that as `default`, so the lowered cell's
    // module.exports would stop being the one the source assigned. The
    // single CommonJS pass below is what binds such a cell, as it does for
    // every cell that takes no metadata pass. import() is routed after it,
    // as for every other cell: before lowering, a name the cell imports
    // could capture the loader's.
    const javascript = await esbuildApi.transform(code, {
      loader: options.loader ?? 'js', target: 'esnext',
      jsx: options.jsx, jsxFactory: options.jsxFactory, jsxFragment: options.jsxFragment,
      jsxImportSource: options.jsxImportSource, jsxDev: options.jsxDev,
      tsconfigRaw: options.tsconfigRaw, define: options.define,
      supported: { 'dynamic-import': true, 'import-meta': true },
    });
    const bound = runtime.rewriteDynamicImports(javascript.code, parent, true, false);
    const lowered = await transformWithEsbuild(esbuildApi, bound, { ...options, loader: 'js', moduleMetadata: false }, runtime.lowerAsyncModule);
    return { ...lowered, code: runtime.rewriteDynamicImports(lowered.code, parent) };
  }
  const result = await transformWithEsbuild(esbuildApi, code, options, runtime.lowerAsyncModule);
  return parent === undefined ? result : { ...result, code: runtime.rewriteDynamicImports(result.code, parent, options?.moduleMetadata) };
}

/**
 * An esbuild diagnostic as RPC can carry it: everything but \`detail\`, which
 * is whatever a plugin threw and may not clone. Notes keep their own text and
 * location (a duplicate declaration's note points at the original).
 */
function serializableMessage({ id, pluginName, text, location, notes }: esbuild.Message): esbuild.Message {
  return { id, pluginName, text, location, notes: notes.map((note) => ({ text: note.text, location: note.location })), detail: undefined };
}

/** esbuild's rejection of a build that failed: an Error carrying its diagnostics. */
function isBuildFailure(value: unknown): value is esbuild.BuildFailure {
  return value instanceof Error && Array.isArray(Reflect.get(value, 'errors')) && Array.isArray(Reflect.get(value, 'warnings'));
}

/**
 * One esbuild build in which `plugin` resolves and loads every module: an
 * EsbuildService without a build host builds this way in its own isolate,
 * the esbuild facet so for a build whose rolldown binding died (serialized
 * into it: self-contained), and the build differentials use it as the
 * reference.
 */
export async function buildWithEsbuild(
  esbuildApi: EsbuildBuildApi,
  options: EsbuildHostBuildOptions,
  plugin: EsbuildRemotePlugin,
): Promise<EsbuildBuildOutcome> {
  let result;
  try {
    result = await esbuildApi.build({
      ...options,
      write: false,
      plugins: [{
        name: plugin.name,
        setup(build) {
          build.onResolve({ filter: /.*/ }, async (args) => (await plugin.resolve({
            path: args.path,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            kind: args.kind,
            with: args.with,
          })) ?? undefined);
          build.onLoad({ filter: /.*/ }, async (args) => (await plugin.load({
            path: args.path,
            namespace: args.namespace,
            suffix: args.suffix,
            with: args.with,
          })) ?? undefined);
        },
      }],
    });
  } catch (failure) {
    // esbuild rejects a failed build with its diagnostics on the error, which RPC drops: they return as data.
    if (!isBuildFailure(failure)) throw failure;
    return {
      outputFiles: [],
      errors: failure.errors.map(serializableMessage),
      warnings: failure.warnings.map(serializableMessage),
      failure: failure.message,
    };
  }
  return {
    outputFiles: (result.outputFiles || []).map((file) => ({ path: file.path, contents: file.contents })),
    errors: result.errors.map(serializableMessage),
    warnings: result.warnings.map(serializableMessage),
    metafile: result.metafile,
  };
}

/** Source the esbuild facet evaluates next to esbuild: its build helpers. */
export function generateEsbuildFacetRuntimeSource(): string {
  return `const { buildWithEsbuild } = ${ESBUILD_FACET_RUNTIME_SOURCE};`;
}

/**
 * Source the transform facet evaluates next to its engine: one transform
 * request, run against anything with esbuild's `transform()` contract
 * (oxc-transform.ts's in the facet).
 */
export function generateTransformFacetRuntimeSource(): string {
  return `const { runTransformRequest } = ${TRANSFORM_FACET_RUNTIME_SOURCE};`;
}

/** One transform a {@link EsbuildTransformHost} runs. */
export interface EsbuildTransformRequest {
  code: string;
  options?: EsbuildTransformOptions;
}

/**
 * A transform's answer. `transient` marks a failure that is no verdict on the
 * source (retry); `stackExhausted` one where the engine ran out of native
 * stack on the module's nesting, which another engine may still answer
 * (oxc-transform.ts's driver sets it from the RangeError it caught, never
 * from message text), with `retry` the request that engine should run where
 * it differs (stripped TypeScript); `typescript` Node's refusal of a TypeScript file.
 */
export type EsbuildTransformOutcome = TransformResult
  | { error: string; transient?: true; stackExhausted?: true; retry?: EsbuildTransformRequest }
  | { error: string; typescript: TypeScriptRefusal; transient?: never; stackExhausted?: never };

/**
 * Runs transforms in another isolate: one call per batch, outcomes positional.
 * A transform engine's wasm memory grows to the working set of the largest
 * module it transforms and is never released, so an isolate that is
 * memory-constrained (a session supervisor) hands its transforms to one of
 * these.
 */
export type EsbuildTransformHost = (requests: EsbuildTransformRequest[]) => Promise<EsbuildTransformOutcome[]>;

/** esbuild's arguments to a resolve callback, as data another isolate can carry. */
export interface EsbuildRemoteResolveArgs {
  path: string;
  importer: string;
  namespace: string;
  resolveDir: string;
  kind: esbuild.ImportKind;
  with: Record<string, string>;
}

/** esbuild's arguments to a load callback, as data another isolate can carry. */
export interface EsbuildRemoteLoadArgs {
  path: string;
  namespace: string;
  suffix: string;
  with: Record<string, string>;
}

/**
 * A plugin's resolve and load callbacks, answered where the plugin runs while
 * esbuild runs elsewhere. `null` leaves the module to esbuild.
 */
export interface EsbuildRemotePlugin {
  /** The plugin's own name, which esbuild's diagnostics cite. */
  name: string;
  resolve(args: EsbuildRemoteResolveArgs): Promise<esbuild.OnResolveResult | null>;
  load(args: EsbuildRemoteLoadArgs): Promise<esbuild.OnLoadResult | null>;
}

/** Build options another isolate can carry: no plugins, and nothing written to disk. */
export type EsbuildHostBuildOptions = Omit<esbuild.BuildOptions, 'plugins' | 'write'>;

/** What one build produced, as data another isolate can carry. */
export interface EsbuildBuildOutcome {
  outputFiles: Array<{ path: string; contents: Uint8Array }>;
  errors: BuildResult['errors'];
  warnings: BuildResult['warnings'];
  metafile?: esbuild.Metafile;
  /** esbuild's message for a build that failed: `errors` hold its diagnostics as data, which a thrown failure loses across RPC. */
  failure?: string;
}

/**
 * Runs a build in another isolate. Every module is resolved and loaded
 * through `plugin`, which stays with the caller and its filesystem view,
 * while the bundler's wasm memory, which grows with the module graph and is
 * never released, lives in the host.
 */
export type EsbuildBuildHost = (options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin) => Promise<EsbuildBuildOutcome>;

export interface EsbuildServiceOptions {
  /** Where transform() and transformMany() run. Absent: this isolate, on `engine`. */
  transformHost?: EsbuildTransformHost;
  /** Where build() runs. Absent: this isolate, on `engine`. */
  buildHost?: EsbuildBuildHost;
  /**
   * The engine a call without a host runs on in this isolate, loaded on the
   * first such call (a test's esbuild-wasm or Oxc, a tool's own). Absent:
   * such a call rejects.
   */
  engine?: () => Promise<EsbuildEngine>;
  /** The type strip a call without a host runs, beside `engine` (a test's amaro): the transform facet's. */
  stripTypeScript?: TransformRuntime['stripTypeScript'];
  /**
   * The transform host's code identity, given with the host: equal ids
   * transform equal requests to equal outcomes. It is what lets a launch keep
   * its results (bundle-cell-transform.ts): a store bound to one id never
   * serves another's. Absent: the host's results are not kept.
   */
  transformHostId?: string;
}

/** The namespace a build resolves workspace files into. */
const VFS_NAMESPACE = 'nimbus-vfs';

/** The workspace paths a build read, from its metafile (`build` always asks for one). */
export function vfsBuildInputs(metafile: esbuild.Metafile | undefined): string[] {
  const prefix = VFS_NAMESPACE + ':';
  return Object.keys(metafile?.inputs ?? {})
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

/**
 * What a build reads modules through: a view of the namespace as some
 * credential, each call answered at once (the engine, a synchronous
 * NamespaceFs) or awaited (a command's ProcessView over a mount).
 */
export interface EsbuildReadFs {
  exists(path: string): Awaitable<boolean>;
  isDirectory(path: string): Awaitable<boolean>;
  readFile(path: string): Awaitable<Uint8Array>;
  readFileString(path: string): Awaitable<string>;
}

/**
 * `plugin`, set up here, answering esbuild's resolve and load callbacks the
 * way esbuild's own dispatch within one plugin does: callbacks in the order
 * registered, and the first to return a result answers.
 */
async function remotePlugin(plugin: esbuild.Plugin, initialOptions: esbuild.BuildOptions): Promise<EsbuildRemotePlugin> {
  const resolvers: Array<{ filter: RegExp; namespace?: string; callback: (args: esbuild.OnResolveArgs) => unknown }> = [];
  const loaders: Array<{ filter: RegExp; namespace?: string; callback: (args: esbuild.OnLoadArgs) => unknown }> = [];
  const build: Pick<esbuild.PluginBuild, 'initialOptions' | 'onResolve' | 'onLoad'> = {
    initialOptions,
    onResolve: (options, callback) => { resolvers.push({ ...options, callback }); },
    onLoad: (options, callback) => { loaders.push({ ...options, callback }); },
  };
  // The VFS plugin reads initialOptions and registers callbacks; it uses nothing else of PluginBuild.
  await plugin.setup(build as esbuild.PluginBuild);
  const matches = (entry: { filter: RegExp; namespace?: string }, path: string, namespace: string) =>
    (entry.namespace === undefined || entry.namespace === namespace) && entry.filter.test(path);
  return {
    name: plugin.name,
    async resolve(args) {
      for (const entry of resolvers) {
        if (!matches(entry, args.path, args.namespace)) continue;
        const result = await entry.callback({ ...args, pluginData: undefined });
        if (result != null) return result as esbuild.OnResolveResult;
      }
      return null;
    },
    async load(args) {
      for (const entry of loaders) {
        if (!matches(entry, args.path, args.namespace)) continue;
        const result = await entry.callback({ ...args, pluginData: undefined });
        if (result != null) return result as esbuild.OnLoadResult;
      }
      return null;
    },
  };
}

/**
 * An ES module request in Node's scope carries the define that unbinds the
 * CommonJS names, which the host's engine applies where the lowering's parse
 * runs out of stack (runTransformRequest), and its result has a typeof of one
 * 'undefined' (module-format.ts esModuleScopeTypeofs; for the lowering's own
 * result, already so).
 */
function requestOptions(options: EsbuildTransformOptions | undefined): EsbuildTransformOptions | undefined {
  return options?.esModule === 'node' || options?.stripTypes ? { ...options, define: { ...options.define, ...ES_MODULE_UNBOUND_NAMES } } : options;
}

function finishedTransform(result: TransformResult, options: EsbuildTransformOptions | undefined): TransformResult {
  return (options?.esModule ?? result.esModule) === 'node' ? { ...result, code: esModuleScopeTypeofs(result.code) } : result;
}

/** What a transform request is run on: a CJS emit of JavaScript has its bundled CommonJS records bound to the runtime's provided packages first. */
function preparedTransformSource(code: string, options: EsbuildTransformOptions | undefined): string {
  if (options?.rewriteOnly) return code;
  const javaScript = !options?.loader || options.loader === 'js' || options.loader === 'jsx';
  return (options?.esModule || options?.format === 'cjs') && javaScript ? rewriteProvidedCommonJsModules(code) : code;
}

/**
 * Source bytes and files one transform host call carries. Bounds CPU work as
 * well as source retention per invocation: in live pi launch profiles the
 * 1 MiB/256-file slice beginning at export-html/index.js exceeded the guest
 * CPU budget even though its first 4 MiB rewrite-only chunk had completed.
 * Smaller independent calls preserve every input and result, while preventing
 * many small full transforms sharing one budget. It is also the unit a paced
 * launch spends its turns in, so no one turn waits on more than a slice.
 */
export const TRANSFORM_SLICE_SOURCE_BYTES = 256 * 1024;
export const TRANSFORM_SLICE_FILES = 32;

/**
 * `items` in order, cut into transform slices: each at most
 * TRANSFORM_SLICE_FILES items and TRANSFORM_SLICE_SOURCE_BYTES of source,
 * except that an item larger than the byte bound travels alone.
 */
export function transformSlices<T>(items: readonly T[], sourceBytes: (item: T) => number): T[][] {
  const slices: T[][] = [];
  let slice: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sourceBytes(item);
    if (slice.length > 0 && (bytes + size > TRANSFORM_SLICE_SOURCE_BYTES || slice.length >= TRANSFORM_SLICE_FILES)) {
      slices.push(slice);
      slice = [];
      bytes = 0;
    }
    slice.push(item);
    bytes += size;
  }
  if (slice.length > 0) slices.push(slice);
  return slices;
}

// ── EsbuildService ──────────────────────────────────────────────────────
export class EsbuildService {
  private vfs: EsbuildReadFs | null;
  private readonly transformHost: EsbuildTransformHost | null;
  private readonly buildHost: EsbuildBuildHost | null;
  /** See EsbuildServiceOptions.transformHostId. */
  readonly transformHostId: string | null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** The in-isolate engine, populated by ensureInit() from `engine`. */
  private _esbuild: EsbuildEngine | null = null;
  private readonly engine: (() => Promise<EsbuildEngine>) | null;
  /** What an in-isolate transform runs besides its engine. */
  private readonly runtime: TransformRuntime;

  /** Build reads use the caller-supplied view, or the one a build names; omit it for transform-only use. */
  constructor(vfs?: EsbuildReadFs, options: EsbuildServiceOptions = {}) {
    this.vfs = vfs ?? null;
    this.transformHost = options.transformHost ?? null;
    this.buildHost = options.buildHost ?? null;
    this.engine = options.engine ?? null;
    this.runtime = { rewriteDynamicImports, lowerAsyncModule, lowerEsModule, rewriteProvidedCommonJsModules, stripTypeScript: options.stripTypeScript };
    this.transformHostId = options.transformHost ? options.transformHostId ?? null : null;
  }

  /** Whether transforms run in this isolate (on its engine): true unless a transform host was given. */
  get transformsInIsolate(): boolean {
    return this.transformHost === null;
  }

  /** Load the in-isolate engine (lazy, on the first call without a host). */
  private async ensureInit(): Promise<void> {
    if (this.initialized && this._esbuild) return;
    if (!this.engine) {
      throw new Error('EsbuildService: no host for this call, and no engine to run it in this isolate (EsbuildServiceOptions.engine)');
    }
    this.initPromise ??= this.engine().then((engine) => {
      this._esbuild = engine;
      this.initialized = true;
    }, (error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  /**
   * Transform a single code string (TS→JS, JSX→JS, minify, etc.)
   *
   * Top-level await: esbuild emits no CommonJS for it, and a node cell is
   * CommonJS. Modern CLI entries use it (nuxi's `bin/nuxi.mjs`, serve 14's
   * `build/main.js`), so when esbuild rejects `format: 'cjs'` for that
   * reason, the module is emitted as ESM and lowered by lowerAsyncModule:
   * imports become requires above a returned async IIFE holding the rest,
   * exports become `module.exports` assignments. The runner awaits the
   * returned promise, so the awaits cannot race process teardown or VFS
   * flushes. Every other source takes esbuild's own CommonJS output.
   */
  async transform(
    code: string,
    options?: EsbuildTransformOptions,
  ): Promise<TransformResult> {
    if (this.transformHost) {
      const [outcome] = await this.transformMany([{ code, options }]);
      if ('error' in outcome) throw new Error(outcome.error);
      return outcome;
    }
    // In the isolate the engine's own error propagates, diagnostics and all.
    const result = await this.transformInIsolate(preparedTransformSource(code, options), requestOptions(options));
    if ('error' in result) throw new Error(result.error);
    return finishedTransform(result, options);
  }

  /** One transform on the in-isolate engine, of source the provided-module pre-pass has seen. */
  private async transformInIsolate(
    code: string, options: EsbuildTransformOptions | undefined,
  ): Promise<TransformResult | { error: string; typescript: TypeScriptRefusal }> {
    // The engine loads for the first request that needs it (an ES module's lowering does not).
    const engine = async () => {
      await this.ensureInit();
      return this._esbuild!;
    };
    return runTransformRequest(engine, code, options, this.runtime);
  }

  /**
   * Transform many modules in one round trip to the transform host (or in
   * this isolate when there is none). Outcomes are positional, and a module
   * the provided-module pre-pass or esbuild rejects is an `{ error }` outcome
   * rather than a rejection, so one bad module never costs the others their
   * output.
   */
  async transformMany(requests: readonly EsbuildTransformRequest[]): Promise<EsbuildTransformOutcome[]> {
    const outcomes: EsbuildTransformOutcome[] = new Array(requests.length);
    const prepared: EsbuildTransformRequest[] = [];
    const positions: number[] = [];
    requests.forEach(({ code, options }, i) => {
      try {
        prepared.push({ code: preparedTransformSource(code, options), options: requestOptions(options) });
        positions.push(i);
      } catch (e) {
        outcomes[i] = { error: errorText(e) };
      }
    });
    if (prepared.length === 0) return outcomes;
    if (this.transformHost) {
      const hosted = await this.transformHost(prepared);
      if (hosted.length !== prepared.length) {
        throw new Error(`esbuild transform host answered ${hosted.length} of ${prepared.length} requests`);
      }
      hosted.forEach((outcome, j) => {
        outcomes[positions[j]] = 'error' in outcome ? outcome : finishedTransform(outcome, requests[positions[j]].options);
      });
      return outcomes;
    }
    for (let j = 0; j < prepared.length; j++) {
      const { code, options } = prepared[j];
      try {
        const result = await this.transformInIsolate(code, options);
        outcomes[positions[j]] = 'error' in result ? result : finishedTransform(result, requests[positions[j]].options);
      } catch (e) {
        outcomes[positions[j]] = { error: errorText(e) };
      }
    }
    return outcomes;
  }

  /**
   * Bundle entry points from the VFS. The VFS plugin runs here over this
   * service's view either way; esbuild itself runs in the build host when
   * one was given.
   */
  async build(
    entryPoints: string[],
    options?: {
      bundle?: boolean;
      format?: 'esm' | 'cjs' | 'iife';
      target?: string;
      platform?: 'browser' | 'node' | 'neutral';
      outdir?: string;
      outfile?: string;
      sourcemap?: boolean | 'inline' | 'external';
      minify?: boolean;
      external?: string[];
      define?: Record<string, string>;
      globalName?: string;
      /** esbuild's JSX options; a tsconfigRaw's JSX settings apply over them, as in esbuild. */
      jsx?: 'transform' | 'preserve' | 'automatic';
      jsxFactory?: string;
      jsxFragment?: string;
      jsxImportSource?: string;
      jsxDev?: boolean;
      /** A tsconfig's text or object, read as esbuild 0.24 reads it (runtime/tsconfig-raw.ts). */
      tsconfigRaw?: string | esbuild.TsconfigRaw;
      alias?: Record<string, string>;
      keepNames?: boolean;
      entryNames?: string;
      chunkNames?: string;
      /** Output-name template for `file`-loader assets, e.g.
       *  'assets/[name]-[hash]'. Only consulted by the viteAssets path. */
      assetNames?: string;
      /**
       * Vite build semantics for imported assets: `import './x.png'`
       * yields a URL string for an emitted `[name]-[hash]` file, `?url`
       * does the same on any extension, `?raw` yields the file text,
       * `?inline` a data: URL, and `url()` references inside `.css`
       * modules emit + rewrite the same way (esbuild's `file` loader).
       * See runtime/vite-assets.ts. Off by default: non-Vite bundling
       * callers (one-shot node, pre-bundle) keep the generic loaders.
       */
      viteAssets?: boolean;
      /**
       * Absolute path of the project `public/` directory. With
       * `viteAssets`, absolute imports like `import '/favicon.svg'`
       * resolve here first and bundle to the literal public URL
       * (`export default "/favicon.svg"`), matching Vite's public-dir
       * semantics — the file is served verbatim, never emitted hashed.
       */
      vitePublicDir?: string;
      /** The view this build reads through, in place of the service's own (a command's, as its credential). */
      fs?: EsbuildReadFs;
    },
  ): Promise<BuildResult> {
    const buildOptions: EsbuildHostBuildOptions = {
      entryPoints: entryPoints.map(ep => ep.startsWith('/') ? ep : '/' + ep),
      bundle: options?.bundle ?? true,
      format: options?.format || 'esm',
      target: options?.target || 'esnext',
      platform: options?.platform || 'browser',
      outdir: options?.outdir || (options?.outfile ? undefined : '/dist'),
      outfile: options?.outfile,
      sourcemap: options?.sourcemap ?? false,
      minify: options?.minify ?? false,
      external: options?.external,
      define: options?.define,
      globalName: options?.globalName,
      jsx: options?.jsx,
      jsxFactory: options?.jsxFactory,
      jsxFragment: options?.jsxFragment,
      jsxImportSource: options?.jsxImportSource,
      jsxDev: options?.jsxDev,
      tsconfigRaw: options?.tsconfigRaw,
      alias: options?.alias,
      keepNames: options?.keepNames,
      entryNames: options?.entryNames,
      chunkNames: options?.chunkNames,
      assetNames: options?.assetNames,
      // Always on: it is the only reliable way for callers to tell entry
      // outputs (and their `cssBundle` sidecars) apart from emitted
      // `file`-loader assets, which output ordering cannot express.
      metafile: true,
      // Prefer ESM builds and modern module fields. This matters for packages
      // like zustand that ship both CJS (main) and ESM (module / exports.import).
      // Without these, esbuild falls back to CJS which wraps everything in
      // __commonJS and only emits `export default`, losing named exports.
      conditions: ['import', 'module', 'browser', 'default'],
      mainFields: ['module', 'browser', 'main'],
    };
    const plugin = await remotePlugin(this.makeVfsPlugin({
      viteAssets: options?.viteAssets,
      vitePublicDir: options?.vitePublicDir,
      fs: options?.fs,
    }), buildOptions);

    let outcome: EsbuildBuildOutcome;
    if (this.buildHost) {
      outcome = await this.buildHost(buildOptions, plugin);
    } else {
      await this.ensureInit();
      outcome = await buildWithEsbuild(this._esbuild!, buildOptions, plugin);
    }
    // One failure wherever esbuild ran: esbuild's message, with its diagnostics.
    if (outcome.failure !== undefined) {
      throw Object.assign(new Error(outcome.failure), { errors: outcome.errors, warnings: outcome.warnings });
    }

    return {
      outputFiles: outcome.outputFiles.map((f) => {
        let text: string | undefined;
        return {
          path: f.path,
          bytes: f.contents,
          get contents() {
            return (text ??= __outputDecoder.decode(f.contents));
          },
        };
      }),
      errors: outcome.errors,
      warnings: outcome.warnings,
      metafile: outcome.metafile,
    };
  }
  private requireVfs(): EsbuildReadFs {
    if (!this.vfs) throw new Error('EsbuildService build requires a VFS');
    return this.vfs;
  }

  /**
   * VFS resolver plugin for esbuild.
   * Reads through the build's view, or the service's (a caller's credentialed
   * view, answered at once or awaited; no snapshot needed).
   * Handles: absolute paths, relative paths, bare specifiers (node_modules),
   * and — with `viteAssets` — Vite's asset/`?suffix` import semantics.
   */
  private makeVfsPlugin(opts?: {
    viteAssets?: boolean;
    vitePublicDir?: string;
    fs?: EsbuildReadFs;
  }): esbuild.Plugin {
    const project = opts?.fs ?? this.requireVfs();
    // A build reads a project a process may be writing: each read waits for a
    // delegation it meets to be recalled (withRecall), so a held file is read
    // as its holder decided it, never taken for one that is not there.
    const vfs: EsbuildReadFs = {
      exists: (path) => withRecall(() => project.exists(path)),
      isDirectory: (path) => withRecall(() => project.isDirectory(path)),
      readFile: (path) => withRecall(() => project.readFile(path)),
      readFileString: (path) => withRecall(() => project.readFileString(path)),
    };
    const resolver = createBundlerResolver({
      isFile: async (path) => await vfs.exists(stripLeadingSlashes(path)) && !await vfs.isDirectory(stripLeadingSlashes(path)),
      isDirectory: async (path) => await vfs.exists(stripLeadingSlashes(path)) && await vfs.isDirectory(stripLeadingSlashes(path)),
      readText: async (path) => {
        try {
          return await vfs.readFileString(stripLeadingSlashes(path));
        } catch {
          return null;
        }
      },
    });

    function inferLoader(path: string): esbuild.Loader {
      const typescript = typescriptLoader(path);
      if (typescript !== null) return typescript;
      if (path.endsWith('.jsx')) return 'jsx';
      if (path.endsWith('.json')) return 'json';
      if (path.endsWith('.css')) return 'css';
      // Native binaries — load as base64 blobs instead of parsing as JS.
      // Defense-in-depth: the npm-installer pre-bundler also skips these,
      // but on-demand bundling or direct `import 'foo.wasm'` could still
      // hand us a raw WASM/native-addon path.
      if (path.endsWith('.wasm')) return 'binary';
      if (path.endsWith('.node')) return 'binary';
      return 'js';
    }

    return {
      name: 'nimbus-vfs',
      setup(build) {
        // Pre-compile the external list into exact matches and prefix patterns.
        // esbuild's `external` supports glob-like patterns (`react/*`) — we
        // reproduce that here so our plugin doesn't override the user's
        // external directive by resolving packages that should stay external.
        const externalList = build.initialOptions.external || [];
        const externalExact = new Set<string>();
        const externalPrefixes: string[] = [];
        for (const pat of externalList) {
          if (pat.endsWith('/*')) {
            externalPrefixes.push(pat.slice(0, -1)); // "react/" prefix (for "react/*")
          } else {
            externalExact.add(pat);
          }
        }
        const isExternal = (spec: string): boolean => {
          if (externalExact.has(spec)) return true;
          for (const pre of externalPrefixes) {
            if (spec.startsWith(pre)) return true;
          }
          return false;
        };

        const viteAssets = opts?.viteAssets === true;
        const publicDir = opts?.vitePublicDir
          ? '/' + normalizeVfsPath(opts.vitePublicDir)
          : null;

        /**
         * Resolve an extension-/`?`-clean specifier through the normal VFS
         * chain. `null` falls through to esbuild's default handling, which
         * reports a proper "Could not resolve" diagnostic — never silently
         * marked external (that would ship a broken import).
         */
        const resolveModulePath = async (spec: string, resolveDir: string, kind: string): Promise<string | null> => {
          if (spec.startsWith('#')) return resolveDir ? resolver.resolvePackageImport(spec, resolveDir) : null;
          if (spec.startsWith('/')) return resolver.resolveFile(spec);
          if (spec.startsWith('.')) return resolveDir ? resolver.resolveFile(resolveDir + '/' + spec) : null;
          return resolver.resolveBarePackage(spec, resolveDir || '/home/user', bundlerConditions(kind));
        };

        build.onResolve({ filter: /.*/ }, async (args) => {
          let spec = args.path;
          let suffix = '';
          if (viteAssets) {
            const [bare, query] = splitImportQuery(args.path);
            spec = bare;
            suffix = query.split('&')[0];
            // Vite's `?` modifiers we understand select a namespace below.
            // Anything else — `?worker`, `?sharedworker`, `?init`,
            // `?module` — has no built-in equivalent; fail loudly instead
            // of shipping a subtly wrong import.
            if (suffix && !VITE_ASSET_QUERY_SUFFIXES[suffix]) {
              return {
                errors: [{
                  text: `Built-in vite build does not support the '?${suffix}' import modifier` +
                    ` (imported as '${args.path}'). Supported: ${Object.keys(VITE_ASSET_QUERY_SUFFIXES).map((s) => '?' + s).join(', ')}.`,
                }],
              };
            }
          }

          // Bare specifier + external → leave as-is so the browser resolves
          // via its own module resolver (which hits /preview/@modules/...).
          // This MUST come before any vfs resolution, otherwise we'd embed
          // the package into the bundle and break single-instance invariants
          // for react/react-dom.
          if (!spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
            if (isExternal(spec)) return { external: true };
          }

          let resolved = await resolveModulePath(spec, args.resolveDir, args.kind);
          let publicImport = false;

          // Vite public/ fallback: `import '/vite.svg'` names a file the
          // dev server serves verbatim from publicDir — it resolves to the
          // literal URL string, never to a hashed emitted file. A user
          // `?` modifier still applies to the public FILE's contents.
          if (viteAssets && !resolved && publicDir && spec.startsWith('/')) {
            const pubPath = publicDir + spec;
            if (await vfs.exists(stripLeadingSlashes(pubPath)) && !await vfs.isDirectory(stripLeadingSlashes(pubPath))) {
              resolved = pubPath;
              publicImport = true;
            }
          }

          if (resolved) {
            // The `?` modifier is carried in the NAMESPACE, not the path:
            // esbuild keys module identity on (namespace, path) but derives
            // emitted-asset names and MIME types from the path — a query
            // left on the path would produce `foo-ABCD.txt?url` files and
            // text/plain data URLs.
            if (publicImport && !suffix) {
              return { path: resolved, namespace: 'nimbus-vfs-public' };
            }
            if (suffix && VITE_ASSET_QUERY_SUFFIXES[suffix]) {
              return { path: resolved, namespace: 'nimbus-vfs-' + suffix };
            }
            return { path: resolved, namespace: VFS_NAMESPACE };
          }
          if (!viteAssets && !spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
            // Mark as external if not found (common for Node built-ins)
            return { external: true };
          }
          return null; // esbuild reports "Could not resolve '<spec>'"
        });

        const loadVfsFile = async (path: string, loader: esbuild.Loader) => {
          const stripped = stripLeadingSlashes(path);
          try {
            const lastSlash = stripped.lastIndexOf('/');
            const resolveDir = lastSlash > 0 ? '/' + stripped.substring(0, lastSlash) : '/';
            // Binary loaders (wasm, native addons) and byte-oriented Vite
            // asset loaders (file → emitted bytes, dataurl/base64 → base64
            // of the raw bytes) must receive raw bytes. TextDecoder would
            // corrupt them with U+FFFD replacement chars.
            if (loader === 'binary' || loader === 'file' || loader === 'dataurl' || loader === 'base64') {
              return { contents: await vfs.readFile(stripped), loader, resolveDir };
            }
            return { contents: await vfs.readFileString(stripped), loader, resolveDir };
          } catch (error) {
            // A file the build's principal may not read is refused as such, not missing.
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
            if (typeof code === 'string' && code !== 'ENOENT') {
              return { errors: [{ text: `${code}: cannot read ${path}` }] };
            }
            return { errors: [{ text: 'File not found in VFS: ' + path }] };
          }
        };

        build.onLoad({ filter: /.*/, namespace: VFS_NAMESPACE }, (args) => {
          const loader = viteAssets
            ? (viteAssetLoader(args.path) ?? inferLoader(args.path))
            : inferLoader(args.path);
          return loadVfsFile(args.path, loader);
        });

        // public/ verbatim: `export default "<public url>"` — the file is
        // served as-is, never emitted hashed.
        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-public' }, (args) => ({
          contents: `export default ${JSON.stringify(publicDir ? args.path.slice(publicDir.length) : args.path)};`,
          loader: 'js' as esbuild.Loader,
        }));

        // One namespace per `?` modifier. The path is already clean, so
        // emitted names/MIME types are correct; the namespace alone tells
        // the modifier apart (and keeps `?raw` vs `?url` on the same file
        // as distinct modules).
        const suffixNamespaces: Record<string, ViteAssetLoaderKind> = {
          url: 'file', raw: 'text', base64: 'base64',
        };
        for (const [suffix, loader] of Object.entries(suffixNamespaces)) {
          build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-' + suffix }, (args) =>
            loadVfsFile(args.path, loader));
        }
        // ?inline needs the extension (`.css` → text, else dataurl).
        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-inline' }, (args) =>
          loadVfsFile(args.path, viteAssetLoader(args.path + '?inline') ?? 'dataurl'));
      },
    };
  }

  get isInitialized() { return this.initialized; }
}
