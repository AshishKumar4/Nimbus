/**
 * EsbuildService — TypeScript/JSX transform + bundling via esbuild-wasm.
 *
 * esbuild-wasm's linear memory starts at ~28 MiB, grows to fit the working
 * set of its transforms/builds, and cannot shrink. A host whose isolate is
 * memory-constrained passes a `transformHost` and a
 * `buildHost` so esbuild runs in another isolate (the session's is the
 * loader-backed esbuild facet); without them, esbuild runs here. build()'s
 * VFS resolver plugin always runs here, over this service's view.
 */
import { FACET_PROVIDED_PACKAGE_ENTRYPOINTS } from '../constants.js';
import { resolvePackageEntry, resolveExports } from '../_shared/exports-resolver.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';
import { errorText } from '../_shared/error-text.js';
import { typescriptLoader } from '../_shared/typescript-specifiers.js';
import { tokenizer, tokTypes } from 'acorn';
import { rewriteDynamicImports } from './dynamic-import-rewrite.js';
import { lowerAsyncModule } from './async-module-lowering.js';
import { keepEsbuild, startObservedEsbuild } from './keep-esbuild.js';
import { literalStringValue, nodeList, nodeName, nodeProp, parseJavaScriptModule, } from './javascript-ast.js';
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
 */
export const BUNDLER_VERSION = 'v11';
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
    const specPkg = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
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
function topLevelModuleDeclarationRanges(source) {
    try {
        const tokens = tokenizer(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowHashBang: true,
        });
        const ranges = [];
        let active = null;
        let braces = 0;
        let parens = 0;
        let brackets = 0;
        // `exports.import = …` is a member, not a declaration.
        let previous = tokTypes.eof;
        const updateDepth = (type) => {
            if (type === tokTypes.braceL || type === tokTypes.dollarBraceL)
                braces++;
            else if (type === tokTypes.braceR)
                braces = Math.max(0, braces - 1);
            else if (type === tokTypes.parenL)
                parens++;
            else if (type === tokTypes.parenR)
                parens = Math.max(0, parens - 1);
            else if (type === tokTypes.bracketL)
                brackets++;
            else if (type === tokTypes.bracketR)
                brackets = Math.max(0, brackets - 1);
        };
        while (true) {
            const token = tokens.getToken();
            const type = token.type;
            if (type === tokTypes.eof)
                return active ? null : ranges;
            const member = previous === tokTypes.dot || previous === tokTypes.questionDot;
            previous = type;
            if (active) {
                updateDepth(type);
                if (type === tokTypes.semi && braces === 0 && parens === 0 && brackets === 0) {
                    ranges.push({ ...active, end: token.end });
                    active = null;
                }
                continue;
            }
            const topLevel = braces === 0 && parens === 0 && brackets === 0;
            if (topLevel && type === tokTypes._import && !member) {
                const next = tokens.getToken();
                previous = next.type;
                if (next.type !== tokTypes.parenL && next.type !== tokTypes.dot) {
                    active = { start: token.start, kind: 'import' };
                }
                updateDepth(next.type);
                continue;
            }
            if (topLevel && type === tokTypes._export && !member) {
                active = { start: token.start, kind: 'export' };
                continue;
            }
            updateDepth(type);
        }
    }
    catch {
        return null;
    }
}
function hasUnscopedAwait(source) {
    try {
        const tokens = tokenizer(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowHashBang: true,
        });
        const functionBraces = [];
        const functionParenDepths = [];
        const methodParenCandidates = [];
        const arrowExpressions = [];
        let bracketDepth = 0;
        let pendingMethodBody = false;
        let pendingArrowBody = false;
        let pendingFunctionKeyword = false;
        let previous = tokTypes.eof;
        let previousEnd = 0;
        while (true) {
            const token = tokens.getToken();
            const type = token.type;
            if (type === tokTypes.eof)
                return false;
            if (pendingMethodBody && type !== tokTypes.braceL)
                pendingMethodBody = false;
            if (pendingArrowBody && type !== tokTypes.braceL) {
                arrowExpressions.push({
                    parens: methodParenCandidates.length,
                    braces: functionBraces.length,
                    brackets: bracketDepth,
                });
                pendingArrowBody = false;
            }
            if (pendingFunctionKeyword) {
                if (type === tokTypes.colon || type === tokTypes.comma || type === tokTypes.braceR
                    || type === tokTypes.parenR || type === tokTypes.bracketR || type === tokTypes.eq)
                    functionParenDepths.pop();
                pendingFunctionKeyword = false;
            }
            if (source.slice(previousEnd, token.start).includes('\n')) {
                while (arrowExpressions.length > 0) {
                    const arrow = arrowExpressions[arrowExpressions.length - 1];
                    if (methodParenCandidates.length !== arrow.parens
                        || functionBraces.length !== arrow.braces
                        || bracketDepth !== arrow.brackets)
                        break;
                    arrowExpressions.pop();
                }
            }
            while (arrowExpressions.length > 0) {
                const arrow = arrowExpressions[arrowExpressions.length - 1];
                const delimited = (type === tokTypes.semi || type === tokTypes.comma)
                    && methodParenCandidates.length === arrow.parens
                    && functionBraces.length === arrow.braces
                    && bracketDepth === arrow.brackets;
                const closed = (type === tokTypes.parenR && methodParenCandidates.length === arrow.parens)
                    || (type === tokTypes.bracketR && bracketDepth === arrow.brackets)
                    || (type === tokTypes.braceR && functionBraces.length === arrow.braces);
                if (!delimited && !closed)
                    break;
                arrowExpressions.pop();
            }
            if (type === tokTypes.name
                && source.slice(token.start, token.end) === 'await'
                && !functionBraces.includes(true)
                && arrowExpressions.length === 0)
                return true;
            if (type === tokTypes._function || type === tokTypes._class) {
                if (previous !== tokTypes.dot && previous !== tokTypes.questionDot) {
                    functionParenDepths.push(methodParenCandidates.length);
                    pendingFunctionKeyword = true;
                }
            }
            else if (type === tokTypes.arrow) {
                pendingArrowBody = true;
            }
            else if (type === tokTypes.parenL) {
                methodParenCandidates.push(functionBraces.length > 0
                    && (previous === tokTypes.name || previous === tokTypes.string
                        || previous === tokTypes.num || previous === tokTypes.bracketR));
            }
            else if (type === tokTypes.parenR) {
                pendingMethodBody = methodParenCandidates.pop() === true;
            }
            else if (type === tokTypes.bracketL) {
                bracketDepth++;
            }
            else if (type === tokTypes.bracketR) {
                bracketDepth = Math.max(0, bracketDepth - 1);
            }
            else if (type === tokTypes.dollarBraceL) {
                functionBraces.push(false);
            }
            else if (type === tokTypes.braceL) {
                const functionBody = pendingArrowBody
                    || pendingMethodBody
                    || functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length;
                if (functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length) {
                    functionParenDepths.pop();
                }
                functionBraces.push(functionBody);
                pendingArrowBody = false;
                pendingMethodBody = false;
            }
            else if (type === tokTypes.braceR) {
                functionBraces.pop();
            }
            previousEnd = token.end;
            previous = type;
        }
    }
    catch {
        return true;
    }
}
function convertBundledModuleDeclarations(snippets, moduleFactory) {
    const imports = [];
    const exports = [];
    // Only generated references use wrapper arguments. Source declarations
    // named module/require/exports retain their own meanings.
    const moduleTarget = moduleFactory ? 'arguments[2]' : 'module';
    const requireTarget = moduleFactory ? 'arguments[1]' : 'module.require';
    let importIndex = 0;
    let markedEsm = false;
    for (const snippet of snippets) {
        const bindingList = snippet.match(/^[ \t]*export\s*\{([\s\S]*)\}\s*;?\s*$/);
        if (bindingList && !/\}\s*from\b/.test(snippet)) {
            if (!markedEsm) {
                exports.push(`Object.defineProperty(${moduleTarget}.exports, "__esModule", { value: true });`);
                markedEsm = true;
            }
            for (const binding of bindingList[1].split(',')) {
                const match = binding.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
                if (!match)
                    return null;
                const local = match[1];
                const exported = match[2] || local;
                exports.push(`Object.defineProperty(${moduleTarget}.exports, ${JSON.stringify(exported)}, { enumerable: true, get: () => ${local} });`);
            }
            continue;
        }
        let ast;
        try {
            ast = parseJavaScriptModule(snippet);
        }
        catch {
            return null;
        }
        const body = nodeList(ast, 'body');
        if (body.length !== 1)
            return null;
        const declaration = body[0];
        if (declaration.type === 'ImportDeclaration') {
            const source = literalStringValue(nodeProp(declaration, 'source'));
            if (!source)
                return null;
            const specifiers = nodeList(declaration, 'specifiers');
            if (specifiers.length === 0) {
                imports.push(`${requireTarget}(${JSON.stringify(source)});`);
                continue;
            }
            const moduleName = `__nimbus_import_${importIndex++}`;
            imports.push(`const ${moduleName} = ${requireTarget}(${JSON.stringify(source)});`);
            for (const specifier of specifiers) {
                const local = nodeName(nodeProp(specifier, 'local'));
                if (!local)
                    return null;
                if (specifier.type === 'ImportDefaultSpecifier') {
                    imports.push(`const ${local} = ${moduleName} && ${moduleName}.__esModule ? ${moduleName}.default : ${moduleName};`);
                }
                else if (specifier.type === 'ImportNamespaceSpecifier') {
                    imports.push(`const ${local} = ${moduleName};`);
                }
                else if (specifier.type === 'ImportSpecifier') {
                    const imported = nodeName(nodeProp(specifier, 'imported'));
                    if (!imported)
                        return null;
                    imports.push(`const ${local} = ${moduleName}[${JSON.stringify(imported)}];`);
                }
                else {
                    return null;
                }
            }
            continue;
        }
        if (declaration.type === 'ExportNamedDeclaration') {
            if (nodeProp(declaration, 'source') || nodeProp(declaration, 'declaration'))
                return null;
            if (!markedEsm) {
                exports.push(`Object.defineProperty(${moduleTarget}.exports, "__esModule", { value: true });`);
                markedEsm = true;
            }
            for (const specifier of nodeList(declaration, 'specifiers')) {
                const local = nodeName(nodeProp(specifier, 'local'));
                const exported = nodeName(nodeProp(specifier, 'exported'));
                if (!local || !exported)
                    return null;
                exports.push(`Object.defineProperty(${moduleTarget}.exports, ${JSON.stringify(exported)}, { enumerable: true, get: () => ${local} });`);
            }
            continue;
        }
        if (declaration.type === 'ExportDefaultDeclaration') {
            const value = nodeProp(declaration, 'declaration');
            if (!value || typeof value.start !== 'number' || typeof value.end !== 'number')
                return null;
            if (value.type === 'FunctionDeclaration' || value.type === 'ClassDeclaration')
                return null;
            if (!markedEsm) {
                exports.push(`Object.defineProperty(${moduleTarget}.exports, "__esModule", { value: true });`);
                markedEsm = true;
            }
            exports.push(`Object.defineProperty(${moduleTarget}.exports, "default", { enumerable: true, value: (${snippet.slice(value.start, value.end)}) });`);
            continue;
        }
        return null;
    }
    return { imports: imports.join('\n'), exports: exports.join('\n') };
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
 * Converts bundler-emitted ESM without constructing an AST or loading
 * esbuild-wasm. Returns null for module declarations that are not the compact,
 * semicolon-terminated shapes emitted by current JS bundlers.
 */
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
                edits.push({ start: a.start, end: last.end, text: '(() => require(' + JSON.stringify(entry[0]) + '))' });
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
    if (edits.length === 0)
        return source;
    const parts = [];
    let cursor = 0;
    for (const edit of edits) {
        parts.push(source.slice(cursor, edit.start), edit.text);
        cursor = edit.end;
    }
    parts.push(source.slice(cursor));
    return parts.join('');
}
export function rewriteBundledEsmToCjs(source, absoluteUrl, moduleFactory = false) {
    if (hasUnscopedAwait(source))
        return null;
    const declarations = topLevelModuleDeclarationRanges(source);
    if (!declarations || declarations.length === 0)
        return null;
    const declarationSnippets = declarations.map(({ start, end }) => source.slice(start, end));
    for (let i = 0; i < declarations.length; i++) {
        if (/^[ \t]*export\s+default\b/.test(declarationSnippets[i])
            && source.slice(declarations[i].end).trim() !== '')
            return null;
    }
    const converted = convertBundledModuleDeclarations(declarationSnippets, moduleFactory);
    if (!converted)
        return null;
    const metaEdits = importMetaEdits(source, absoluteUrl, moduleFactory);
    if (!metaEdits)
        return null;
    const edits = [
        ...declarations.map(({ start, end }) => ({ start, end, text: '' })),
        ...metaEdits.filter((edit) => !declarations.some(({ start, end }) => edit.start >= start && edit.end <= end)),
    ].sort((a, b) => a.start - b.start);
    const bodyParts = [];
    let cursor = 0;
    for (const edit of edits) {
        if (edit.start < cursor)
            return null;
        bodyParts.push(source.slice(cursor, edit.start), edit.text);
        cursor = edit.end;
    }
    bodyParts.push(source.slice(cursor));
    const body = bodyParts.join('');
    return {
        code: (moduleFactory ? '"use strict";\n' : '') + converted.imports + '\n' + body + '\n' + converted.exports,
        map: '',
        warnings: [],
    };
}
/**
 * Cached reference to the esbuild namespace. Populated on first
 * `loadEsbuild()` call; nullable until then so module-load code paths
 * that never touch bundling can complete without ever evaluating
 * esbuild-wasm's JS at all.
 */
let _esbuildMod = null;
let _esbuildLoadPromise = null;
/**
 * Load the esbuild-wasm namespace. Safe to call many times; concurrent
 * callers share a single in-flight Promise, and a rejection clears the
 * cache so a later call can retry.
 *
 * Exported so `tests/unit/esbuild-wasm-entrypoint.mjs` can drive the real
 * specifier under a Node-style resolver. A test that restated the specifier
 * would grade its own copy of it, and this defect reached production
 * precisely because nothing graded the resolution.
 *
 * The specifier stays a literal: a computed one would defeat the host
 * bundler's static analysis and leave the module out of the deployed worker.
 */
export async function loadEsbuild() {
    if (_esbuildMod)
        return _esbuildMod;
    if (_esbuildLoadPromise)
        return _esbuildLoadPromise;
    _esbuildLoadPromise = (async () => {
        // Deliberately dynamic: a static import would evaluate esbuild-wasm in
        // every session, including the ones that only serve a shell and never
        // bundle. The specifier is still a literal so the host bundler sees it.
        const mod = await import('esbuild-wasm/esm/browser.js');
        _esbuildMod = mod;
        return _esbuildMod;
    })();
    try {
        return await _esbuildLoadPromise;
    }
    catch (e) {
        _esbuildLoadPromise = null;
        throw e;
    }
}
const __outputDecoder = new TextDecoder();
/**
 * `lower` is async-module-lowering.ts's `lowerAsyncModule`, passed in because
 * this function is serialized into the esbuild facet.
 */
async function transformWithEsbuild(esbuildApi, code, options, lower) {
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
                tsconfigRaw: options?.tsconfigRaw,
                define: options?.define,
                supported: { 'dynamic-import': options?.dynamicImportParent !== undefined, 'import-meta': options?.moduleMetadata === true },
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
            tsconfigRaw: options?.tsconfigRaw,
            define: options?.define,
            supported: { 'dynamic-import': options?.dynamicImportParent !== undefined, 'import-meta': options?.moduleMetadata === true },
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
        tsconfigRaw: options?.tsconfigRaw,
        define: options?.define,
        supported: { 'dynamic-import': options?.dynamicImportParent !== undefined, 'import-meta': options?.moduleMetadata === true },
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
 * function is serialized into the esbuild facet. `esbuildApi` is null only
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
        // every cell that takes no metadata pass.
        const javascript = await esbuildApi.transform(code, {
            loader: options.loader ?? 'js', target: 'esnext',
            jsx: options.jsx, jsxFactory: options.jsxFactory, jsxFragment: options.jsxFragment,
            tsconfigRaw: options.tsconfigRaw, define: options.define,
            supported: { 'dynamic-import': true, 'import-meta': true },
        });
        const routed = rewrite(javascript.code, parent, true);
        return transformWithEsbuild(esbuildApi, routed, { ...options, loader: 'js', moduleMetadata: false }, lower);
    }
    const result = await transformWithEsbuild(esbuildApi, code, options, lower);
    return parent === undefined ? result : { ...result, code: rewrite(result.code, parent, options?.moduleMetadata) };
}
/**
 * One esbuild build in which `plugin` resolves and loads every module,
 * wherever that plugin runs. Self-contained: it is serialized into the
 * esbuild facet as well as called here.
 */
async function buildWithEsbuild(esbuildApi, options, plugin) {
    const result = await esbuildApi.build({
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
    return {
        outputFiles: (result.outputFiles || []).map((file) => ({ path: file.path, contents: file.contents })),
        errors: result.errors.map((message) => ({ text: message.text, location: message.location })),
        warnings: result.warnings.map((message) => ({ text: message.text, location: message.location })),
        metafile: result.metafile,
    };
}
/**
 * Source the esbuild facet evaluates next to esbuild: its transform and build
 * helpers, and the esbuild it keeps for transforms (keep-esbuild.ts).
 */
export function generateEsbuildFacetRuntimeSource() {
    return [
        transformWithEsbuild.toString(),
        runTransformRequest.toString(),
        buildWithEsbuild.toString(),
        keepEsbuild.toString(),
        startObservedEsbuild.toString(),
    ].join('\n');
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
    /** Resolved esbuild namespace — populated by ensureInit() after loadEsbuild(). */
    _esbuild = null;
    /** Build reads use the caller-supplied view, or the one a build names; omit it for transform-only use. */
    constructor(vfs, options = {}) {
        this.vfs = vfs ?? null;
        this.transformHost = options.transformHost ?? null;
        this.buildHost = options.buildHost ?? null;
        this.transformHostId = options.transformHost ? options.transformHostId ?? null : null;
    }
    /** Whether transforms grow this isolate's esbuild heap: true unless a transform host was given. */
    get transformsInIsolate() {
        return this.transformHost === null;
    }
    /**
     * Initialize esbuild-wasm (lazy, on first use). Loads the namespace
     * via `loadEsbuild()` (which itself is deferred) and caches it on
     * `this._esbuild` so subsequent calls don't pay the dynamic-import
     * overhead. All call sites that previously used the top-level
     * `esbuild` namespace now use `this._esbuild!` after `await this.ensureInit()`.
     */
    async ensureInit() {
        if (this.initialized && this._esbuild)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = (async () => {
            try {
                const esb = await loadEsbuild();
                this._esbuild = esb;
                // Keep the bundled precompiled asset off importers' static graph until initialization.
                const { default: esbuildWasmModule } = await import('esbuild-wasm/esbuild.wasm');
                if (!(esbuildWasmModule instanceof WebAssembly.Module)) {
                    throw new Error('esbuild-wasm bundled import is not a WebAssembly.Module. ' +
                        'Rebuild the worker so wrangler resolves ' +
                        '`esbuild-wasm/esbuild.wasm` at bundle time. ' +
                        'NO CDN fallback (100% edge contract).');
                }
                // [WRANGLER-DEV-HANG P0b] Time-bound esb.initialize. Workerd
                // has historically had cases where wasm init blocks indefinitely;
                // 30 s is well above the typical ~200 ms init time.
                const INIT_TIMEOUT_MS = 30_000;
                let initTimeout = null;
                await Promise.race([
                    esb.initialize({
                        wasmModule: esbuildWasmModule,
                        worker: false,
                    }),
                    new Promise((_, reject) => {
                        initTimeout = setTimeout(() => {
                            reject(new Error(`esbuild init exceeded ${INIT_TIMEOUT_MS / 1000}s. ` +
                                `wasmModule type=${typeof esbuildWasmModule}; ` +
                                `Likely cause: WebAssembly compile/init stall in workerd.`));
                        }, INIT_TIMEOUT_MS);
                    }),
                ]).finally(() => { if (initTimeout)
                    clearTimeout(initTimeout); });
                this.initialized = true;
            }
            catch (e) {
                const message = errorText(e);
                // "Cannot call initialize more than once" means it's already ready
                if (message.includes('more than once')) {
                    this.initialized = true;
                    return;
                }
                this.initPromise = null;
                throw new Error('esbuild init failed: ' + message);
            }
        })();
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
        if (!options?.rewriteOnly)
            await this.ensureInit();
        const prepared = options?.rewriteOnly ? code : withProvidedModuleRewrite(code, options);
        return runTransformRequest(this._esbuild, prepared, options, rewriteDynamicImports, lowerAsyncModule);
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
                prepared.push({ code: options?.rewriteOnly ? code : withProvidedModuleRewrite(code, options), options });
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
        if (prepared.some(({ options }) => !options?.rewriteOnly))
            await this.ensureInit();
        for (let j = 0; j < prepared.length; j++) {
            const { code, options } = prepared[j];
            try {
                outcomes[positions[j]] = await runTransformRequest(this._esbuild, code, options, rewriteDynamicImports, lowerAsyncModule);
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
        const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
        const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];
        // Path helpers shared with git/commands.ts via vfs/path.ts.
        // Local aliases preserve the existing call-site readability inside this
        // closure; behavior is identical (the canonical normalizeVfsPath has a
        // bounds check on `..` that the previous local `normalize` lacked, but
        // for the well-formed paths esbuild produces this is a no-op).
        const strip = stripLeadingSlashes;
        const normalize = normalizeVfsPath;
        /**
         * Try to resolve a VFS path with extension/index fallbacks.
         *
         * Resolution order (first match wins):
         *   1. Exact path as given (covers `.ts`, `.js`, `.json`, `.css`, and
         *      any extension on disk) — via `''` being first in EXTS.
         *   2. Append-extension candidates from EXTS (`.ts`, `.tsx`, `.js`, …)
         *      for extensionless imports like `./foo`.
         *   3. TypeScript/ESM `moduleResolution: "bundler"` compatibility:
         *      if the input ends in `.js` / `.mjs` / `.cjs` / `.jsx` and
         *      NO file matched above, swap the extension to the TS
         *      equivalent and try those. This is the idiomatic
         *      `import {X} from './y.js'` pattern where on-disk it's `y.ts`.
         *      Order (TS spec): `.ts` → `.tsx` for `.js`/`.jsx`;
         *                        `.mts`       for `.mjs`;
         *                        `.cts`       for `.cjs`.
         *      Exact-match (step 1) happens first so a real `.js` on disk
         *      takes precedence over a co-located `.ts` — we never pretend
         *      a `.ts` is canonical when a `.js` actually exists.
         *   4. Directory index files (e.g. `./foo/index.ts`) as a last step.
         */
        async function tryResolve(base) {
            const norm = normalize(base);
            for (const ext of EXTS) {
                const candidate = norm + ext;
                if (await vfs.exists(strip(candidate)) && !await vfs.isDirectory(strip(candidate))) {
                    return '/' + strip(candidate);
                }
            }
            // Step 3: TypeScript-bundler extension swap. Only runs when no
            // exact / extension-append match succeeded above — so real `.js`
            // files on disk always win.
            const jsExtMatch = norm.match(/\.(js|mjs|cjs|jsx)$/);
            if (jsExtMatch) {
                const withoutExt = norm.slice(0, norm.length - jsExtMatch[0].length);
                const swapMap = {
                    js: ['.ts', '.tsx'],
                    jsx: ['.tsx', '.ts'],
                    mjs: ['.mts', '.ts'],
                    cjs: ['.cts', '.ts'],
                };
                const swaps = swapMap[jsExtMatch[1]] || [];
                for (const tsExt of swaps) {
                    const candidate = withoutExt + tsExt;
                    if (await vfs.exists(strip(candidate)) && !await vfs.isDirectory(strip(candidate))) {
                        return '/' + strip(candidate);
                    }
                }
            }
            // Step 4: directory index fallback.
            if (await vfs.exists(strip(norm)) && await vfs.isDirectory(strip(norm))) {
                for (const idx of INDEX_FILES) {
                    const candidate = norm + '/' + idx;
                    if (await vfs.exists(strip(candidate)))
                        return '/' + strip(candidate);
                }
            }
            return null;
        }
        /**
         * Resolve a Node.js subpath import (`#foo`).
         *
         * Per https://nodejs.org/api/packages.html#subpath-imports, a specifier
         * starting with `#` is looked up in the closest ancestor package.json's
         * `imports` field (not `exports`). This is used by packages like `vfile`
         * to switch between node and browser implementations:
         *
         *   "imports": {
         *     "#minpath": {
         *       "node": "./lib/minpath.js",
         *       "default": "./lib/minpath.browser.js"
         *     }
         *   }
         *
         * We walk up from the importer's directory looking for package.json.
         * Once found, we resolve the subpath using the same condition algorithm
         * as `exports` (with `import`, `module`, `browser`, `default` — skipping
         * `node` since we're bundling for the browser).
         *
         * The resolved value is a path relative to the owning package root, which
         * we turn back into a VFS path for esbuild to load.
         */
        async function resolvePackageImport(specifier, fromDir) {
            let dir = strip(fromDir);
            const visited = new Set();
            while (dir && !visited.has(dir)) {
                visited.add(dir);
                const pkgJsonPath = dir + '/package.json';
                if (await vfs.exists(strip(pkgJsonPath))) {
                    try {
                        const pkgJson = JSON.parse(await vfs.readFileString(strip(pkgJsonPath)));
                        if (pkgJson.imports) {
                            // resolveExports happens to work for the imports field too —
                            // both are subpath→condition maps using the same format. We
                            // reuse it. The specifier (`#minpath`) IS the subpath key.
                            const resolved = resolveExports(pkgJson.imports, specifier);
                            if (resolved) {
                                // Resolved value is relative to the owning package root
                                const pkgRoot = dir;
                                const absPath = pkgRoot + '/' + resolved.replace(/^\.\//, '');
                                const finalPath = await tryResolve(absPath);
                                if (finalPath)
                                    return finalPath;
                            }
                        }
                    }
                    catch { /* malformed package.json — try parent */ }
                }
                // Stop at node_modules boundary — subpath imports only resolve against
                // the consuming package's own package.json, not its dependencies'.
                // But DO go up through node_modules/<pkg>/ to find <pkg>/package.json.
                if (dir.endsWith('/node_modules') || dir === 'node_modules')
                    break;
                const lastSlash = dir.lastIndexOf('/');
                if (lastSlash <= 0)
                    break;
                dir = dir.substring(0, lastSlash);
            }
            return null;
        }
        // Conditions per-resolution. CJS `require('X')` callers need the
        // `require` condition selected so packages that ship a dual-export
        // CJS trick (e.g. @babel/runtime/helpers/X — `module.exports = fn;
        // module.exports.default = module.exports;`) resolve to the CJS
        // file. The ESM helper file declares only `export { fn as default }`,
        // which esbuild's __toCommonJS wrap surfaces to CJS callers as
        // `{ default: fn }` — and the downstream callsite calls the
        // namespace as a function and crashes with
        // `_objectWithoutPropertiesLoose2 is not a function`.
        //
        // This affects every CJS-shipping npm package that depends on
        // `@babel/runtime/helpers/*` (thousands — anything compiled with
        // `@babel/preset-env`'s `transform-runtime`).
        // See pre-bundle-facet.ts for the matching fix in the install-time
        // pre-bundle plugin. Both code paths must agree.
        const ESM_CONDITIONS = ['import', 'module', 'browser', 'default'];
        const CJS_CONDITIONS = ['require', 'node', 'browser', 'default'];
        /**
         * Resolve bare specifier (npm package) by walking up node_modules.
         * Uses the full Node.js exports-field algorithm. `conditions` is
         * passed through so caller can request CJS-flavoured resolution
         * (for `require()` calls in bundled CJS code).
         */
        async function resolveBarePkg(specifier, fromDir, conditions) {
            // Split scoped packages: @scope/pkg → ["@scope/pkg"]
            // Split subpath imports: pkg/sub/path → pkg, sub/path
            let pkgName;
            let subpath;
            if (specifier.startsWith('@')) {
                const parts = specifier.split('/');
                pkgName = parts.slice(0, 2).join('/');
                subpath = parts.slice(2).join('/');
            }
            else {
                const parts = specifier.split('/');
                pkgName = parts[0];
                subpath = parts.slice(1).join('/');
            }
            // Walk up directories looking for node_modules/<pkg>
            let dir = strip(fromDir);
            const visited = new Set();
            while (dir && !visited.has(dir)) {
                visited.add(dir);
                const nmDir = dir + '/node_modules/' + pkgName;
                if (await vfs.exists(strip(nmDir)) && await vfs.isDirectory(strip(nmDir))) {
                    // Read package.json so we can consult the exports field.
                    const pkgJsonPath = nmDir + '/package.json';
                    let pkgJson = null;
                    if (await vfs.exists(strip(pkgJsonPath))) {
                        try {
                            pkgJson = JSON.parse(await vfs.readFileString(strip(pkgJsonPath)));
                        }
                        catch { }
                    }
                    if (pkgJson) {
                        // Use the full exports-field resolution. Conditions are
                        // caller-supplied so `require()` and `import` get distinct
                        // resolutions per Node spec.
                        const subpathKey = subpath ? './' + subpath : '.';
                        const entry = resolvePackageEntry(pkgJson, subpathKey, conditions);
                        if (entry) {
                            const resolved = await tryResolve(nmDir + '/' + entry.replace(/^\.\//, ''));
                            if (resolved)
                                return resolved;
                        }
                    }
                    // Fallback for subpath: try direct file resolution (e.g. pkg/lib/foo).
                    if (subpath) {
                        const resolved = await tryResolve(nmDir + '/' + subpath);
                        if (resolved)
                            return resolved;
                    }
                    // Fallback for root: try index files directly
                    const resolved = await tryResolve(nmDir + '/index');
                    if (resolved)
                        return resolved;
                }
                // Move up one directory
                const lastSlash = dir.lastIndexOf('/');
                if (lastSlash <= 0)
                    break;
                dir = dir.substring(0, lastSlash);
            }
            return null;
        }
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
                    ? '/' + strip(normalize(opts.vitePublicDir))
                    : null;
                /**
                 * Resolve an extension-/`?`-clean specifier through the normal VFS
                 * chain. `null` falls through to esbuild's default handling, which
                 * reports a proper "Could not resolve" diagnostic — never silently
                 * marked external (that would ship a broken import).
                 */
                const resolveModulePath = async (spec, resolveDir, kind) => {
                    // 1. Subpath imports (#foo) — Node.js package.json `imports` field.
                    // These MUST be resolved against the owning package's package.json,
                    // not node_modules. Used by vfile, unified, and others to switch
                    // between node/browser implementations.
                    if (spec.startsWith('#') && resolveDir) {
                        return resolvePackageImport(spec, strip(resolveDir));
                    }
                    // 2. Absolute paths
                    if (spec.startsWith('/'))
                        return tryResolve(spec);
                    // 3. Relative paths
                    if (spec.startsWith('.') && resolveDir) {
                        return tryResolve(strip(resolveDir) + '/' + spec);
                    }
                    // 4. Bare specifier (npm package)
                    if (!spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
                        const fromDir = resolveDir || '/home/user';
                        // Per Node spec: `require()` triggers the 'require' condition,
                        // `import` triggers 'import'. esbuild surfaces this via
                        // args.kind. Without this, packages that ship a dual-export
                        // CJS file alongside a bare ESM file (e.g. @babel/runtime/
                        // helpers/*) get resolved to the ESM variant for CJS callers,
                        // and the `__toCommonJS` wrapper surfaces `{ default: fn }`
                        // to a callsite that expects the function directly — runtime
                        // crash with "<helper>2 is not a function" on the first
                        // route that uses the affected package.
                        const conditions = kind === 'require-call' || kind === 'require-resolve'
                            ? CJS_CONDITIONS
                            : ESM_CONDITIONS;
                        return resolveBarePkg(spec, fromDir, conditions);
                    }
                    return null;
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
                        if (await vfs.exists(strip(pubPath)) && !await vfs.isDirectory(strip(pubPath))) {
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
                        return { path: resolved, namespace: 'nimbus-vfs' };
                    }
                    if (!viteAssets && !spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
                        // Mark as external if not found (common for Node built-ins)
                        return { external: true };
                    }
                    return null; // esbuild reports "Could not resolve '<spec>'"
                });
                const loadVfsFile = async (path, loader) => {
                    const stripped = strip(path);
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
                    catch {
                        return { errors: [{ text: 'File not found in VFS: ' + path }] };
                    }
                };
                build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs' }, (args) => {
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
