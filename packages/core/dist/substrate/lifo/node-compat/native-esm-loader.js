/**
 * Native ES modules for lifo. The engine owns linking, bindings and evaluation;
 * the hooks supply only VFS sources and facades for lifo's CommonJS modules
 * and builtins. A private file-URL root keeps the hooks out of host imports.
 * Node's require(esm) checks file/node/data specifiers before calling a hook,
 * so a private non-file scheme cannot serve a synchronous module graph.
 */
import { fileURLToPath } from 'node:url';
import { createEsmResolver } from '../../../_shared/esm-resolver.js';
import { pathToFileURL } from './file-url.js';
import { cjsModuleExportNames } from '../../../runtime/cjs-module-exports.js';
import { NODE_BUILTIN_EXPORTS } from '../../../runtime/node-builtin-exports.js';
import { dataModule, importCallArguments } from '../../../runtime/esm-loader-policy.js';
import { escapedIdentifierNames, readModuleImportSites } from '../../../runtime/dynamic-import-rewrite.js';
import { hasTopLevelAwait } from '../../../runtime/esm-require-hoist.js';
import { applySourceEdits, containsModuleSyntax, isAstNode, MODULE_PARSE_OPTIONS, parseStatements } from '../../../runtime/javascript-ast.js';
import { builtinFacadeModule, bunScopeNames, commonJsFacadeModule, ESM_HOST_MODULE, ESM_META_MODULE, metaModuleSource, relativeSpecifier, stageEsModule, } from '../../../runtime/native-esm.js';
import { requiredEsModule, sourceColumn } from '../../../runtime/native-esm-runtime.js';
import { dirname } from '../utils/path.js';
import { isProvidedPackage, servedName } from './module.js';
const PRIVATE_PATH = '/__nimbus_lifo__/';
const PRIVATE_ROOT = `file://${PRIVATE_PATH}`;
const ACCESSOR = '__nimbusLifoNativeModules';
const ASYNC_REQUIRE_MESSAGE = 'require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.';
const loaders = new Map();
let nextLoader = 0;
let installed;
function owner(url) {
    const id = new URL(url).pathname.slice(PRIVATE_PATH.length).split('/')[0];
    const loader = loaders.get(id);
    if (!loader)
        throw new Error(`lifo: native module loader ${id} is no longer available`);
    return loader;
}
const privateUrl = (url) => url?.startsWith(PRIVATE_ROOT) === true;
const privatePath = (path) => path.startsWith(PRIVATE_PATH);
/** Installed once in a realm, including a host realm shared by lifo commands. */
function installHooks() {
    return installed ??= (async () => {
        const module = await import('node:module');
        Object.defineProperty(globalThis, ACCESSOR, { value: (id) => {
                const loader = loaders.get(id);
                if (!loader)
                    throw new Error(`lifo: native module loader ${id} is no longer available`);
                return loader;
            } });
        const bun = Reflect.get(globalThis, 'Bun');
        if (bun?.plugin) {
            bun.plugin({ name: 'nimbus-lifo-native-esm', setup(build) {
                    build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
                        const url = path.startsWith('file:') ? path : privatePath(path) ? pathToFileURL(path).href : undefined;
                        const parent = importer.startsWith('file:') ? importer : privatePath(importer) ? pathToFileURL(importer).href : undefined;
                        if (!privateUrl(url) && !privateUrl(parent))
                            return;
                        const target = owner(url ?? parent).resolve(path, parent);
                        return { path: fileURLToPath(target) };
                    });
                    build.onLoad({ filter: /^\/__nimbus_lifo__\// }, ({ path }) => {
                        const url = pathToFileURL(path).href;
                        return { contents: owner(url).load(url), loader: 'js' };
                    });
                } });
        }
        else {
            if (typeof module.registerHooks !== 'function') {
                throw new Error('lifo native ES modules require Node >= 22.15 with node:module.registerHooks, or Bun with Bun.plugin');
            }
            module.registerHooks({
                resolve(specifier, context, nextResolve) {
                    const url = privatePath(specifier) ? pathToFileURL(specifier).href : specifier;
                    if (!privateUrl(url) && !privateUrl(context.parentURL))
                        return nextResolve(specifier, context);
                    return { url: owner(privateUrl(url) ? url : context.parentURL).resolve(url, context.parentURL), format: 'module', shortCircuit: true };
                },
                load(url, context, nextLoad) {
                    if (!privateUrl(url))
                        return nextLoad(url, context);
                    return { source: owner(url).load(url), format: 'module', shortCircuit: true };
                },
            });
        }
        installFrames();
        return module;
    })();
}
/**
 * The realm's stack formatter, given the frames of a loader's modules as
 * Node's read: the module's own URL and its source's column. Assigned, not
 * defined: Bun keeps the hook behind its own setter. A program's own hook
 * replaces it, as it replaces the realm's.
 */
function installFrames() {
    const realm = Reflect.get(Error, 'prepareStackTrace');
    if (typeof realm !== 'function')
        return;
    Reflect.set(Error, 'prepareStackTrace', function prepareStackTrace(error, sites) {
        return Reflect.apply(realm, this, [error, sites.map(placedSite)]);
    });
}
function placedSite(site) {
    const file = site.getFileName();
    const line = site.getLineNumber();
    const column = site.getColumnNumber();
    if (!file || line === null || column === null)
        return site;
    const url = privatePath(file) ? pathToFileURL(file).href : file;
    const place = privateUrl(url) ? loaders.get(new URL(url).pathname.slice(PRIVATE_PATH.length).split('/')[0])?.frame(url, line, column) : null;
    if (!place)
        return site;
    const from = `${file}:${line}:${column}`;
    const to = `${place.file}:${line}:${place.column}`;
    return new Proxy(site, {
        get(target, key) {
            if (key === 'getFileName' || key === 'getScriptNameOrSourceURL')
                return () => place.file;
            if (key === 'getColumnNumber')
                return () => place.column;
            if (key === 'toString') {
                return () => {
                    const text = String(target);
                    const at = text.lastIndexOf(from);
                    return at === -1 ? text : text.slice(0, at) + to + text.slice(at + from.length);
                };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
/** A loader's own sources, builtins, records and metadata under one private URL root. */
export async function createNativeEsmLoader(context, cjs, main) {
    const hostModule = await installHooks();
    const bun = Reflect.get(globalThis, 'Bun') !== undefined;
    const id = String(++nextLoader);
    const root = `${PRIVATE_ROOT}${id}/`;
    const records = new Map();
    const byId = [];
    const byName = new Map();
    const exportNames = new Map();
    const builtinSync = new Set();
    const evalMain = main?.filename === '[eval]';
    const mainPath = evalMain ? `${context.cwd}/[eval1]` : main?.filename;
    const mainUrl = mainPath ? pathToFileURL(mainPath).href : undefined;
    const resolver = createEsmResolver({
        kind(path) {
            if (path === mainPath)
                return 'file';
            const fs = context.filesystem();
            return fs.isFile(path) ? 'file' : fs.isDirectory(path) ? 'directory' : null;
        },
        realpath: (path) => path === mainPath ? path : context.filesystem().realpath(path),
        readText: (path) => path === mainPath ? main.source : context.filesystem().exists(path) ? context.filesystem().readFileString(path) : null,
        isBuiltin: (specifier) => servedName(cjs.moduleMap, specifier) !== null,
        cjsResolve: (specifier, parent) => cjs.resolveFilename(specifier, dirname(parent)),
    }, { cwd: () => context.cwd, stripTypes: false });
    function recordFor(resolution) {
        const known = records.get(resolution.url);
        if (known)
            return known;
        resolver.assertLoadable(resolution);
        let source = resolution.path === mainPath ? main?.source : undefined;
        let format = resolution.format;
        if (format === 'detect') {
            source ??= context.filesystem().readFileString(resolution.path);
            format = containsModuleSyntax(source) ? 'module' : 'commonjs';
        }
        if (format === 'data') {
            const data = dataModule(resolution.url);
            if (data.format === null) {
                throw Object.assign(new RangeError(`Unknown module format: ${data.mime} for URL ${resolution.url}`), { code: 'ERR_UNKNOWN_MODULE_FORMAT' });
            }
            ({ format, source } = data);
        }
        const recordId = byId.length;
        const publicUrl = new URL(resolution.url);
        const query = publicUrl.search + publicUrl.hash;
        // URL queries are cache keys in Node, but Bun strips them before a
        // hook runs. Keep that identity in an injectively escaped filename.
        const queryName = encodeURIComponent(query).replace(/~/g, '%7E').replace(/%/g, '~');
        const name = format === 'module' && resolution.path
            ? `vfs/${query ? `query/${queryName}` : 'plain'}${publicUrl.pathname}`
            : `nimbus/facade/${recordId}.js`;
        const record = { id: recordId, name, resolution: { ...resolution, format }, source, state: 'new' };
        records.set(resolution.url, record);
        byId.push(record);
        byName.set(name, record);
        return record;
    }
    function sourceOf(record) {
        return record.source ??= context.filesystem().readFileString(record.resolution.path);
    }
    function resolveRecord(specifier, parent, attributes = {}) {
        const resolution = resolver.resolveSync(specifier, parent);
        resolver.validateAttributes(resolution.url, resolution.format, attributes);
        return recordFor(resolution);
    }
    function publicParent(url) {
        const name = url.slice(root.length);
        const record = byName.get(name);
        if (!record)
            throw new Error(`lifo: unknown native module ${url}`);
        return record.resolution.url;
    }
    // Bun drops file-URL queries before plugins see them. Meta instances must
    // have distinct filenames there, or every module would share the first one's metadata.
    function engineSource(source, name) {
        if (!bun)
            return source;
        const sites = readModuleImportSites(source);
        return applySourceEdits(source, sites.statics.flatMap((site) => {
            const url = new URL(site.specifier, root + name);
            if (url.href.split('?')[0] !== root + ESM_META_MODULE || !url.search)
                return [];
            const instance = url.search.slice(1);
            return [{ start: site.start, end: site.end, text: JSON.stringify(relativeSpecifier(name, `nimbus/meta-${instance}.js`)) }];
        }));
    }
    function explain(error) {
        if (error instanceof Error) {
            // Bun names the resolved file in a link error; Node names the import
            // as written. The engine has already decided which export is missing.
            const missing = bun && error instanceof SyntaxError ? /^Export named '(.*)' not found in module '(.*)'\.$/s.exec(error.message) : null;
            if (missing) {
                const target = byId.find((record) => [root + record.name, fileURLToPath(root + record.name)].includes(missing[2]));
                if (target?.resolution.format === 'module') {
                    let specifier;
                    for (const importer of byId) {
                        if (importer.resolution.format !== 'module')
                            continue;
                        parseStatements(sourceOf(importer), MODULE_PARSE_OPTIONS, { onStatement(statement) {
                                if (specifier !== undefined || !isAstNode(statement.source) || typeof statement.source.value !== 'string')
                                    return;
                                if (statement.type !== 'ImportDeclaration' && statement.type !== 'ExportNamedDeclaration')
                                    return;
                                const names = statement.specifiers;
                                if (!names.some((node) => {
                                    if (!isAstNode(node))
                                        return false;
                                    const name = node.type === 'ImportDefaultSpecifier' ? 'default' : node.type === 'ImportSpecifier' ? node.imported : node.local;
                                    return name === missing[1] || isAstNode(name) && (name.name ?? name.value) === missing[1];
                                }))
                                    return;
                                if (resolver.resolveSync(statement.source.value, importer.resolution.url).url === target.resolution.url)
                                    specifier = statement.source.value;
                            } });
                        if (specifier !== undefined)
                            break;
                    }
                    if (specifier !== undefined)
                        error.message = `The requested module '${specifier}' does not provide an export named '${missing[1]}'`;
                }
            }
            // Private loader paths are engine implementation details, not program filenames.
            for (const record of byId) {
                const target = record.resolution.path ?? record.resolution.url;
                for (const from of [root + record.name, fileURLToPath(root + record.name)]) {
                    error.message = error.message.split(from).join(target);
                    if (error.stack)
                        error.stack = error.stack.split(from).join(target);
                }
            }
        }
        throw error;
    }
    function failedGraph(record, error, seen = new Set()) {
        if (!record || seen.has(record) || record.resolution.format !== 'module')
            return;
        seen.add(record);
        if (record.state === 'entered') {
            record.state = 'failed';
            record.failure = { value: error };
        }
        else if (record.state === 'loading')
            record.state = 'new';
        try {
            for (const site of readModuleImportSites(sourceOf(record)).statics) {
                failedGraph(resolveRecord(site.specifier, record.resolution.url, site.attributes), error, seen);
            }
        }
        catch { /* A link failure has no evaluated body whose state needs changing. */ }
    }
    // Bun's require evaluates async graphs and tolerates require/ESM cycles.
    // Reject those graphs before asking its engine to evaluate them; no body is emulated.
    function checkRequireGraph(record, parent, seen = new Set(), root = record) {
        if (seen.has(record) || record.resolution.format !== 'module')
            return;
        seen.add(record);
        if (record.failure)
            throw record.failure.value;
        const source = sourceOf(record);
        // Node's texts: the graph's TLA names the require() and its module;
        // a cycle names the require() that began the module's evaluation.
        if (record.topLevelAwait ??= hasTopLevelAwait(source)) {
            const requiring = root.resolution.path ?? root.resolution.url;
            throw Object.assign(new Error(`${ASYNC_REQUIRE_MESSAGE}\n  From ${parent ?? ''} \n  Requiring ${requiring} `), { code: 'ERR_REQUIRE_ASYNC_MODULE' });
        }
        if (record.state === 'entered' || record.state === 'loading') {
            const from = record.requirer ?? parent;
            throw Object.assign(new Error(`Cannot require() ES Module ${record.resolution.path ?? record.resolution.url} in a cycle.${from ? ` (from ${from})` : ''}`), { code: 'ERR_REQUIRE_CYCLE_MODULE' });
        }
        for (const site of readModuleImportSites(source).statics) {
            checkRequireGraph(resolveRecord(site.specifier, record.resolution.url, site.attributes), parent, seen, root);
        }
    }
    /** A builtin as require() has it: a core module by its scheme, a provided package by its name. */
    const requireBuiltin = (name) => cjs.requireFrom(context.cwd)(isProvidedPackage(name) ? name : `node:${name}`);
    /** A builtin facade's names: a core module's Node's, a provided package's its own (as require() gives it). */
    function builtinExportNames(name) {
        if (!isProvidedPackage(name))
            return NODE_BUILTIN_EXPORTS[name] ?? [];
        const exported = requireBuiltin(name);
        return (typeof exported === 'object' && exported !== null) || typeof exported === 'function'
            ? Object.keys(exported).filter((key) => key !== 'default') : [];
    }
    const native = {
        async importModule(specifier, parentUrl, options) {
            let record;
            try {
                const call = importCallArguments(specifier, options);
                record = resolveRecord(call.specifier, parentUrl, call.attributes);
                return await import(/* @vite-ignore */ root + record.name);
            }
            catch (error) {
                if (bun)
                    failedGraph(record, error);
                return explain(error);
            }
        },
        requireModule(filename, parentFilename) {
            let record;
            let evaluating = false;
            try {
                const path = filename === mainPath ? filename : context.filesystem().realpath(filename);
                record = recordFor({ url: pathToFileURL(path).href, path, format: 'module' });
                const caller = parentFilename && parentFilename !== '[eval]' ? parentFilename
                    : context.filename === '[eval]' ? `${context.cwd}/[eval]` : context.filename;
                if (bun)
                    checkRequireGraph(record, caller);
                evaluating = true;
                if (record.state === 'new')
                    record.requirer ??= caller;
                const namespace = hostModule.createRequire(pathToFileURL(caller).href)(root + record.name);
                return bun ? requiredEsModule(record.required ??= { namespace: record.namespace ?? namespace }) : namespace;
            }
            catch (error) {
                if (bun && evaluating)
                    failedGraph(record, error);
                return explain(error);
            }
        },
        async importMain() {
            if (!main || !mainPath || !mainUrl)
                throw new Error('lifo: no native ES module entry');
            let record;
            try {
                record = recordFor({ url: mainUrl, path: mainPath, format: 'module' });
                return await import(/* @vite-ignore */ root + record.name);
            }
            catch (error) {
                if (bun)
                    failedGraph(record, error);
                return explain(error);
            }
        },
        syncBuiltinESMExports() {
            for (const sync of builtinSync)
                sync();
        },
        dispose() { loaders.delete(id); },
    };
    const hooks = {
        resolve(specifier, parent) {
            const requested = privatePath(specifier) ? pathToFileURL(specifier).href : specifier;
            if (requested.startsWith(root))
                return requested;
            if (!parent?.startsWith(root))
                throw new Error(`lifo: import outside its module graph: ${specifier}`);
            const relative = new URL(specifier, parent).href;
            const name = relative.slice(root.length);
            if (relative.startsWith(root) && (byName.has(name) || name === ESM_HOST_MODULE || name.startsWith(ESM_META_MODULE + '?') || bun && name.startsWith('nimbus/meta-')))
                return relative;
            return root + resolveRecord(specifier, publicParent(parent)).name;
        },
        load(url) {
            const name = url.slice(root.length);
            if (name === ESM_HOST_MODULE)
                return `export const host = globalThis[${JSON.stringify(ACCESSOR)}](${JSON.stringify(id)});\n`;
            if (name.startsWith(ESM_META_MODULE + '?'))
                return metaModuleSource(false);
            if (bun && name.startsWith('nimbus/meta-')) {
                const instance = name.slice('nimbus/meta-'.length, -'.js'.length);
                const source = metaModuleSource(false);
                // The instance's `import.meta`, as the query names it: Bun's is its file's.
                return applySourceEdits(source, readModuleImportSites(source).metas.map((site) => ({ ...site, text: `({ url: ${JSON.stringify(`${root}${ESM_META_MODULE}?${instance}`)} })` })));
            }
            const record = byName.get(name);
            if (!record)
                throw new Error(`lifo: unknown native module ${url}`);
            if (record.resolution.format === 'builtin')
                return engineSource(builtinFacadeModule(record.name, record.id, builtinExportNames(record.resolution.builtin)), record.name);
            if (record.resolution.format === 'json')
                return engineSource(commonJsFacadeModule(record.name, record.id, ['default']), record.name);
            if (record.resolution.format === 'commonjs') {
                const names = cjsModuleExportNames(record.resolution.path, {
                    source: (path) => context.filesystem().readFileString(path),
                    resolve: (specifier, path) => cjs.resolveFilename(specifier, dirname(path)),
                }, exportNames, sourceOf(record));
                return engineSource(commonJsFacadeModule(record.name, record.id, [...names]), record.name);
            }
            const source = sourceOf(record);
            const sites = readModuleImportSites(source);
            const targets = sites.statics.map((site) => resolveRecord(site.specifier, record.resolution.url, site.attributes).name);
            if (bun && record.state === 'new')
                record.state = 'loading';
            // Bun's injected require is its host loader, not lifo's. Node scope
            // must not acquire that capability just by reading a free wrapper name.
            const escaped = bun && source.includes('\\u') ? escapedIdentifierNames(source) : new Set();
            const mentioned = ['require', '__filename', '__dirname'].filter((name) => escaped.has(name));
            const commonJsNames = bun ? bunScopeNames(source + (mentioned.length ? `\n/* ${mentioned.join(' ')} */` : '')) : undefined;
            const staged = stageEsModule(source, sites, { id: record.id, name: record.name, targets, commonJsNames });
            const lines = new Map();
            for (const edit of staged.columns)
                lines.set(edit[0], [...lines.get(edit[0]) ?? [], edit]);
            record.positions = { head: staged.head, lines };
            return engineSource(staged.text, record.name);
        },
        frame(url, line, column) {
            const record = byName.get(url.slice(root.length));
            if (!record?.positions)
                return null;
            const { head, lines } = record.positions;
            return { file: record.resolution.url, column: sourceColumn(lines.get(line), line === 1 ? column - head : column) };
        },
        enter(url) {
            const record = byId[Number(new URL(url).search.slice(1))];
            if (!record)
                throw new Error(`lifo: unknown native module metadata ${url}`);
            const { resolution } = record;
            const path = resolution.path;
            return {
                m: {
                    __proto__: null,
                    ...(path ? { dirname: dirname(path), filename: path } : {}),
                    main: !evalMain && resolution.url === mainUrl,
                    resolve: (specifier) => resolver.metaResolveSync(specifier, resolution.url),
                    url: resolution.url,
                },
                i: (specifier, options) => native.importModule(specifier, resolution.url, options),
                c: () => { record.state = 'entered'; },
                r: (namespace) => { record.namespace = namespace; record.state = 'done'; },
                l: () => resolution.format === 'builtin' ? requireBuiltin(resolution.builtin)
                    : resolution.format === 'json' && !path ? JSON.parse(sourceOf(record)) : cjs.load(path),
                s: (sync) => { builtinSync.add(sync); },
                q: undefined, f: undefined, d: undefined,
            };
        },
    };
    loaders.set(id, hooks);
    cjs.setNativeLoader(native);
    return native;
}
