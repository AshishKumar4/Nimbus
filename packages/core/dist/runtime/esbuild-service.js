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
import { FACET_PROVIDED_PACKAGE_ENTRYPOINTS } from '../constants.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';
import { errorText } from '../_shared/error-text.js';
import { typescriptLoader } from '../_shared/typescript-specifiers.js';
import { tokenizer, tokTypes } from 'acorn';
import { rewriteDynamicImports } from './dynamic-import-rewrite.js';
import { packageNameFromSpecifier } from './barrel-detect.js';
import { bundlerConditions, createBundlerResolver } from './bundler-resolution.js';
import { emitCommonJs, lowerAsyncModule, readEsmModule } from './async-module-lowering.js';
import { ES_MODULE_UNBOUND_NAMES } from './module-format.js';
import { applySourceEdits, hasUnscopedAwait, nodeList, nodeName, nodeProp, parseJavaScriptModule, walkTopLevelModuleTokens, } from './javascript-ast.js';
import { VITE_ASSET_QUERY_SUFFIXES, splitImportQuery, viteAssetLoader, } from './vite-assets.js';
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
export function getSharedRuntimeExternals(specifier) {
    // react: the canonical bundle. No externals — it's the source of truth.
    if (specifier === 'react')
        return [];
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
        if (pat === specifier)
            return false;
        if (pat.endsWith('/*')) {
            const prefix = pat.slice(0, -1); // e.g. 'react-dom/'
            const pkgName = pat.slice(0, -2); // e.g. 'react-dom'
            if (specifier.startsWith(prefix))
                return false;
            if (specifier === pkgName)
                return false;
            if (specPkg === pkgName)
                return false;
        }
        else {
            // Plain (non-glob) external. Drop if the spec being bundled is
            // a subpath of this external's package.
            if (specPkg === pat)
                return false;
        }
        return true;
    });
}
/** The top-level import and export declarations, each through its `;`; null when one is unterminated or the source does not tokenize. */
function topLevelModuleDeclarationRanges(source) {
    const ranges = [];
    let active = null;
    const walked = walkTopLevelModuleTokens(source, (token, syntax, topLevel) => {
        if (active) {
            if (token.type === tokTypes.semi && topLevel) {
                ranges.push({ ...active, end: token.end });
                active = null;
            }
        }
        else if (syntax === 'import' || syntax === 'export') {
            active = { start: token.start, kind: syntax };
        }
        return false;
    });
    return walked === null || active ? null : ranges;
}
function importMetaEdits(source, absoluteUrl, moduleFactory) {
    // A module factory's import.meta is the module's metadata object, bound by
    // the facet's rewrite of every MetaProperty (dynamic-import-rewrite.ts), so
    // any property — Vite's chunks read `import.meta.dirname`, `.env`, `.hot` —
    // is left for that pass, exactly as esbuild's output leaves it.
    if (moduleFactory)
        return [];
    const edits = [];
    const urlExpression = JSON.stringify(absoluteUrl);
    try {
        const tokens = tokenizer(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowHashBang: true,
        });
        while (true) {
            const start = tokens.getToken();
            if (start.type === tokTypes.eof)
                return edits;
            if (start.type !== tokTypes._import)
                continue;
            const dot1 = tokens.getToken();
            if (dot1.type !== tokTypes.dot)
                continue;
            const meta = tokens.getToken();
            if (meta.type !== tokTypes.name || source.slice(meta.start, meta.end) !== 'meta')
                return null;
            const dot2 = tokens.getToken();
            if (dot2.type !== tokTypes.dot)
                return null;
            const property = tokens.getToken();
            if (property.type !== tokTypes.name)
                return null;
            const propertyName = source.slice(property.start, property.end);
            if (propertyName === 'url') {
                edits.push({ start: start.start, end: property.end, text: urlExpression });
            }
            else if (propertyName === 'resolve') {
                edits.push({
                    start: start.start,
                    end: property.end,
                    text: `(specifier => globalThis.__nimbusImportMetaResolve(specifier, ${urlExpression}))`,
                });
            }
            else {
                return null;
            }
        }
    }
    catch {
        return null;
    }
}
/**
 * The runtime's function a bound record calls for its package: the one the
 * module system serves (node-shims.ts), named apart from the module's own
 * `require`, which an ES module does not have (module-format.ts).
 */
export const PROVIDED_PACKAGE_HOOK = '__nimbusProvidedPackage';
/** Bind canonical esbuild/Bun CommonJS records to the runtime's provided packages. */
export function rewriteProvidedCommonJsModules(source) {
    const helpers = new Set(['__commonJS']);
    const declarations = topLevelModuleDeclarationRanges(source);
    if (!declarations)
        return source;
    for (const range of declarations) {
        const declaration = source.slice(range.start, range.end);
        if (tokenizer(declaration, { ecmaVersion: 'latest', sourceType: 'module' }).getToken().type !== tokTypes._import)
            continue;
        const parsed = parseJavaScriptModule(declaration);
        for (const statement of nodeList(parsed, 'body')) {
            if (statement.type !== 'ImportDeclaration')
                continue;
            for (const specifier of nodeList(statement, 'specifiers')) {
                if (nodeName(nodeProp(specifier, 'imported')) !== '__commonJS')
                    continue;
                const local = nodeName(nodeProp(specifier, 'local'));
                if (local)
                    helpers.add(local);
            }
        }
    }
    const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    let a = tokens.getToken();
    let b = tokens.getToken();
    let c = tokens.getToken();
    let d = tokens.getToken();
    let e = tokens.getToken();
    let previous = tokTypes.eof;
    const edits = [];
    while (a.type !== tokTypes.eof) {
        const labelValue = 'value' in d ? d.value : undefined;
        const helperValue = 'value' in a ? a.value : undefined;
        const label = d.type === tokTypes.string && typeof labelValue === 'string' ? labelValue : null;
        const entry = label === null ? undefined : Object.entries(FACET_PROVIDED_PACKAGE_ENTRYPOINTS).find(([name, path]) => {
            const suffix = 'node_modules/' + name + '/' + path;
            return label === suffix || label.endsWith('/' + suffix);
        });
        if (a.type === tokTypes.name && typeof helperValue === 'string' && helpers.has(helperValue)
            && previous !== tokTypes.dot && previous !== tokTypes.questionDot
            && b.type === tokTypes.parenL && c.type === tokTypes.braceL && entry
            && e.type === tokTypes.parenL) {
            let parens = 2;
            let braces = 1;
            let singleModule = true;
            let bodySeen = false;
            let last = e;
            let pendingComma = false;
            while (parens > 0) {
                const token = tokens.getToken();
                if (token.type === tokTypes.eof)
                    return source;
                if (pendingComma && token.type !== tokTypes.braceR)
                    singleModule = false;
                pendingComma = false;
                if (token.type === tokTypes.braceL || token.type === tokTypes.dollarBraceL) {
                    if (braces === 1 && parens === 1)
                        bodySeen = true;
                    braces++;
                }
                else if (token.type === tokTypes.braceR)
                    braces--;
                if (token.type === tokTypes.parenL)
                    parens++;
                else if (token.type === tokTypes.parenR)
                    parens--;
                if (braces === 1 && parens === 1 && token.type === tokTypes.comma)
                    pendingComma = true;
                if (braces === 0 && parens === 1 && token.type !== tokTypes.braceR)
                    singleModule = false;
                last = token;
            }
            if (singleModule && bodySeen && braces === 0) {
                edits.push({ start: a.start, end: last.end, text: `(() => ${PROVIDED_PACKAGE_HOOK}(${JSON.stringify(entry[0])}))` });
            }
            previous = last.type;
            a = tokens.getToken();
            b = tokens.getToken();
            c = tokens.getToken();
            d = tokens.getToken();
            e = tokens.getToken();
            continue;
        }
        previous = a.type;
        a = b;
        b = c;
        c = d;
        d = e;
        e = tokens.getToken();
    }
    return edits.length === 0 ? source : applySourceEdits(source, edits);
}
/**
 * A large ES module (bundle-cell-transform.ts BUNDLED_ESM_REWRITE_MIN_BYTES)
 * lowered to CommonJS in the session, without the transform host: read a
 * statement at a time (readEsmRecords, bounded memory, imports live) and
 * emitted by the one emitter. Null for what it leaves to the host: top-level
 * await (its body is synchronous), an import.meta member it does not bind, a
 * module acorn cannot parse, and a source with no module syntax.
 */
export function rewriteBundledEsmToCjs(source, absoluteUrl, moduleFactory = false) {
    if (hasUnscopedAwait(source))
        return null;
    // Read a statement at a time (readEsmRecords), so a multi-MiB bundle reads
    // in bounded memory, imports live. What acorn cannot parse is left to the
    // transform host, which has the last word on syntax.
    let read;
    try {
        read = readEsmModule(source);
    }
    catch {
        return null;
    }
    const { records, wrapperUses } = read;
    if (records.length === 0)
        return null;
    const metaEdits = importMetaEdits(source, absoluteUrl, moduleFactory);
    if (!metaEdits)
        return null;
    // A free use of a CommonJS wrapper name binds nothing in an ES module, as
    // the transform's define has it (ES_MODULE_UNBOUND_NAMES).
    const unbound = [];
    for (const [name, references] of wrapperUses) {
        const to = ES_MODULE_UNBOUND_NAMES[name];
        for (const { start, end, use } of references)
            unbound.push({ start, end, text: use === 'shorthand' ? `${name}: ${to}` : to });
    }
    // Only generated references use wrapper arguments. Source declarations
    // named module/require/exports retain their own meanings. An import.meta
    // is one token run, so it is inside a record's range or outside every one.
    const code = emitCommonJs(source, records, {
        body: 'sync',
        exportsObject: moduleFactory ? 'arguments[2].exports' : 'module.exports',
        requireFunction: moduleFactory ? 'arguments[1]' : 'module.require',
        edits: [...metaEdits, ...unbound].filter((edit) => !records.some(({ start, end }) => edit.start >= start && edit.end <= end)),
    });
    return { code: (moduleFactory ? '"use strict";\n' : '') + code, map: '', warnings: [] };
}
const __outputDecoder = new TextDecoder();
/**
 * `lower` is async-module-lowering.ts's `lowerAsyncModule`, passed in because
 * this function is serialized into the transform facet.
 */
async function transformWithEsbuild(esbuildApi, code, options, lower) {
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/top-level await.*not supported.*cjs/i.test(message))
                throw error;
        }
        // A hashbang is valid only at the start of a script. The TLA fallback
        // moves the body into an async function, so keep its line as a comment
        // before either fallback pass (Vite bin/vite.js imported by Vinext).
        if (code.startsWith('#!'))
            code = '//' + code.slice(2);
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
 * One transform request as a transform host runs it: esbuild (unless the
 * code is already CommonJS), then, for a module whose dynamic `import()` is
 * the process's, the rewrite that routes each one to the process's ESM loader.
 * `rewrite` is dynamic-import-rewrite.ts's `rewriteDynamicImports` and `lower`
 * async-module-lowering.ts's `lowerAsyncModule`, passed in because this
 * function is serialized into the transform facet. `esbuildApi` is null only
 * before esbuild is loaded, which a rewrite-only request does not wait for.
 */
async function runTransformRequest(esbuildApi, code, options, rewrite, lower) {
    const parent = options?.dynamicImportParent;
    if (options?.rewriteOnly) {
        if (parent === undefined)
            throw new Error('a rewrite-only transform needs dynamicImportParent');
        return { code: rewrite(code, parent, options.moduleMetadata), map: '', warnings: [] };
    }
    if (esbuildApi === null)
        throw new Error('esbuild transform before esbuild is loaded');
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
        const bound = rewrite(javascript.code, parent, true, false);
        const lowered = await transformWithEsbuild(esbuildApi, bound, { ...options, loader: 'js', moduleMetadata: false }, lower);
        return { ...lowered, code: rewrite(lowered.code, parent) };
    }
    const result = await transformWithEsbuild(esbuildApi, code, options, lower);
    return parent === undefined ? result : { ...result, code: rewrite(result.code, parent, options?.moduleMetadata) };
}
/**
 * An esbuild diagnostic as RPC can carry it: everything but \`detail\`, which
 * is whatever a plugin threw and may not clone. Notes keep their own text and
 * location (a duplicate declaration's note points at the original).
 */
function serializableMessage({ id, pluginName, text, location, notes }) {
    return { id, pluginName, text, location, notes: notes.map((note) => ({ text: note.text, location: note.location })), detail: undefined };
}
/** esbuild's rejection of a build that failed: an Error carrying its diagnostics. */
function isBuildFailure(value) {
    return value instanceof Error && Array.isArray(Reflect.get(value, 'errors')) && Array.isArray(Reflect.get(value, 'warnings'));
}
/**
 * One esbuild build in which `plugin` resolves and loads every module: an
 * EsbuildService without a build host builds this way in its own isolate,
 * the esbuild facet so for a build whose rolldown binding died (serialized
 * into it: self-contained), and the build differentials use it as the
 * reference.
 */
export async function buildWithEsbuild(esbuildApi, options, plugin) {
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
    }
    catch (failure) {
        // esbuild rejects a failed build with its diagnostics on the error, which RPC drops: they return as data.
        if (!isBuildFailure(failure))
            throw failure;
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
export function generateEsbuildFacetRuntimeSource() {
    return [isBuildFailure.toString(), serializableMessage.toString(), buildWithEsbuild.toString()].join('\n');
}
/**
 * Source the transform facet evaluates next to its engine: one transform
 * request, run against anything with esbuild's `transform()` contract
 * (oxc-transform.ts's in the facet).
 */
export function generateTransformFacetRuntimeSource() {
    return [transformWithEsbuild.toString(), runTransformRequest.toString()].join('\n');
}
/** The namespace a build resolves workspace files into. */
const VFS_NAMESPACE = 'nimbus-vfs';
/** The workspace paths a build read, from its metafile (`build` always asks for one). */
export function vfsBuildInputs(metafile) {
    const prefix = VFS_NAMESPACE + ':';
    return Object.keys(metafile?.inputs ?? {})
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
}
/**
 * `plugin`, set up here, answering esbuild's resolve and load callbacks the
 * way esbuild's own dispatch within one plugin does: callbacks in the order
 * registered, and the first to return a result answers.
 */
async function remotePlugin(plugin, initialOptions) {
    const resolvers = [];
    const loaders = [];
    const build = {
        initialOptions,
        onResolve: (options, callback) => { resolvers.push({ ...options, callback }); },
        onLoad: (options, callback) => { loaders.push({ ...options, callback }); },
    };
    // The VFS plugin reads initialOptions and registers callbacks; it uses nothing else of PluginBuild.
    await plugin.setup(build);
    const matches = (entry, path, namespace) => (entry.namespace === undefined || entry.namespace === namespace) && entry.filter.test(path);
    return {
        name: plugin.name,
        async resolve(args) {
            for (const entry of resolvers) {
                if (!matches(entry, args.path, args.namespace))
                    continue;
                const result = await entry.callback({ ...args, pluginData: undefined });
                if (result != null)
                    return result;
            }
            return null;
        },
        async load(args) {
            for (const entry of loaders) {
                if (!matches(entry, args.path, args.namespace))
                    continue;
                const result = await entry.callback({ ...args, pluginData: undefined });
                if (result != null)
                    return result;
            }
            return null;
        },
    };
}
/** What a transform request hands the engine: its source after the provided-module pre-pass, unless it asks only for the rewrite. */
function preparedTransformSource(code, options) {
    return options?.rewriteOnly ? code : withProvidedModuleRewrite(code, options);
}
/** A CJS emit of JavaScript binds bundled CommonJS records to the runtime's provided packages first. */
function withProvidedModuleRewrite(code, options) {
    return options?.format === 'cjs' && (!options.loader || options.loader === 'js' || options.loader === 'jsx')
        ? rewriteProvidedCommonJsModules(code)
        : code;
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
export function transformSlices(items, sourceBytes) {
    const slices = [];
    let slice = [];
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
    if (slice.length > 0)
        slices.push(slice);
    return slices;
}
// ── EsbuildService ──────────────────────────────────────────────────────
export class EsbuildService {
    vfs;
    transformHost;
    buildHost;
    /** See EsbuildServiceOptions.transformHostId. */
    transformHostId;
    initialized = false;
    initPromise = null;
    /** The in-isolate engine, populated by ensureInit() from `engine`. */
    _esbuild = null;
    engine;
    /** Build reads use the caller-supplied view, or the one a build names; omit it for transform-only use. */
    constructor(vfs, options = {}) {
        this.vfs = vfs ?? null;
        this.transformHost = options.transformHost ?? null;
        this.buildHost = options.buildHost ?? null;
        this.engine = options.engine ?? null;
        this.transformHostId = options.transformHost ? options.transformHostId ?? null : null;
    }
    /** Whether transforms run in this isolate (on its engine): true unless a transform host was given. */
    get transformsInIsolate() {
        return this.transformHost === null;
    }
    /** Load the in-isolate engine (lazy, on the first call without a host). */
    async ensureInit() {
        if (this.initialized && this._esbuild)
            return;
        if (!this.engine) {
            throw new Error('EsbuildService: no host for this call, and no engine to run it in this isolate (EsbuildServiceOptions.engine)');
        }
        this.initPromise ??= this.engine().then((engine) => {
            this._esbuild = engine;
            this.initialized = true;
        }, (error) => {
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
    async transform(code, options) {
        if (this.transformHost) {
            const [outcome] = await this.transformMany([{ code, options }]);
            if ('error' in outcome)
                throw new Error(outcome.error);
            return outcome;
        }
        // In the isolate the engine's own error propagates, diagnostics and all.
        return this.transformInIsolate(preparedTransformSource(code, options), options);
    }
    /** One transform on the in-isolate engine, of source the provided-module pre-pass has seen. */
    async transformInIsolate(code, options) {
        if (!options?.rewriteOnly)
            await this.ensureInit();
        return runTransformRequest(this._esbuild, code, options, rewriteDynamicImports, lowerAsyncModule);
    }
    /**
     * Transform many modules in one round trip to the transform host (or in
     * this isolate when there is none). Outcomes are positional, and a module
     * the provided-module pre-pass or esbuild rejects is an `{ error }` outcome
     * rather than a rejection, so one bad module never costs the others their
     * output.
     */
    async transformMany(requests) {
        const outcomes = new Array(requests.length);
        const prepared = [];
        const positions = [];
        requests.forEach(({ code, options }, i) => {
            try {
                prepared.push({ code: preparedTransformSource(code, options), options });
                positions.push(i);
            }
            catch (e) {
                outcomes[i] = { error: errorText(e) };
            }
        });
        if (prepared.length === 0)
            return outcomes;
        if (this.transformHost) {
            const hosted = await this.transformHost(prepared);
            if (hosted.length !== prepared.length) {
                throw new Error(`esbuild transform host answered ${hosted.length} of ${prepared.length} requests`);
            }
            hosted.forEach((outcome, j) => { outcomes[positions[j]] = outcome; });
            return outcomes;
        }
        for (let j = 0; j < prepared.length; j++) {
            const { code, options } = prepared[j];
            try {
                outcomes[positions[j]] = await this.transformInIsolate(code, options);
            }
            catch (e) {
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
    async build(entryPoints, options) {
        const buildOptions = {
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
        let outcome;
        if (this.buildHost) {
            outcome = await this.buildHost(buildOptions, plugin);
        }
        else {
            await this.ensureInit();
            outcome = await buildWithEsbuild(this._esbuild, buildOptions, plugin);
        }
        // One failure wherever esbuild ran: esbuild's message, with its diagnostics.
        if (outcome.failure !== undefined) {
            throw Object.assign(new Error(outcome.failure), { errors: outcome.errors, warnings: outcome.warnings });
        }
        return {
            outputFiles: outcome.outputFiles.map((f) => {
                let text;
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
    requireVfs() {
        if (!this.vfs)
            throw new Error('EsbuildService build requires a VFS');
        return this.vfs;
    }
    /**
     * VFS resolver plugin for esbuild.
     * Reads through the build's view, or the service's (a caller's credentialed
     * view, answered at once or awaited; no snapshot needed).
     * Handles: absolute paths, relative paths, bare specifiers (node_modules),
     * and — with `viteAssets` — Vite's asset/`?suffix` import semantics.
     */
    makeVfsPlugin(opts) {
        const vfs = opts?.fs ?? this.requireVfs();
        const resolver = createBundlerResolver({
            isFile: async (path) => await vfs.exists(stripLeadingSlashes(path)) && !await vfs.isDirectory(stripLeadingSlashes(path)),
            isDirectory: async (path) => await vfs.exists(stripLeadingSlashes(path)) && await vfs.isDirectory(stripLeadingSlashes(path)),
            readText: async (path) => {
                try {
                    return await vfs.readFileString(stripLeadingSlashes(path));
                }
                catch {
                    return null;
                }
            },
        });
        function inferLoader(path) {
            const typescript = typescriptLoader(path);
            if (typescript !== null)
                return typescript;
            if (path.endsWith('.jsx'))
                return 'jsx';
            if (path.endsWith('.json'))
                return 'json';
            if (path.endsWith('.css'))
                return 'css';
            // Native binaries — load as base64 blobs instead of parsing as JS.
            // Defense-in-depth: the npm-installer pre-bundler also skips these,
            // but on-demand bundling or direct `import 'foo.wasm'` could still
            // hand us a raw WASM/native-addon path.
            if (path.endsWith('.wasm'))
                return 'binary';
            if (path.endsWith('.node'))
                return 'binary';
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
                const externalExact = new Set();
                const externalPrefixes = [];
                for (const pat of externalList) {
                    if (pat.endsWith('/*')) {
                        externalPrefixes.push(pat.slice(0, -1)); // "react/" prefix (for "react/*")
                    }
                    else {
                        externalExact.add(pat);
                    }
                }
                const isExternal = (spec) => {
                    if (externalExact.has(spec))
                        return true;
                    for (const pre of externalPrefixes) {
                        if (spec.startsWith(pre))
                            return true;
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
                const resolveModulePath = async (spec, resolveDir, kind) => {
                    if (spec.startsWith('#'))
                        return resolveDir ? resolver.resolvePackageImport(spec, resolveDir) : null;
                    if (spec.startsWith('/'))
                        return resolver.resolveFile(spec);
                    if (spec.startsWith('.'))
                        return resolveDir ? resolver.resolveFile(resolveDir + '/' + spec) : null;
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
                        if (isExternal(spec))
                            return { external: true };
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
                const loadVfsFile = async (path, loader) => {
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
                    }
                    catch (error) {
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
                    loader: 'js',
                }));
                // One namespace per `?` modifier. The path is already clean, so
                // emitted names/MIME types are correct; the namespace alone tells
                // the modifier apart (and keeps `?raw` vs `?url` on the same file
                // as distinct modules).
                const suffixNamespaces = {
                    url: 'file', raw: 'text', base64: 'base64',
                };
                for (const [suffix, loader] of Object.entries(suffixNamespaces)) {
                    build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-' + suffix }, (args) => loadVfsFile(args.path, loader));
                }
                // ?inline needs the extension (`.css` → text, else dataurl).
                build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-inline' }, (args) => loadVfsFile(args.path, viteAssetLoader(args.path + '?inline') ?? 'dataurl'));
            },
        };
    }
    get isInitialized() { return this.initialized; }
}
