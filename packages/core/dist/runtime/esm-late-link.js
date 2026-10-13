/**
 * runtime/esm-late-link.ts — Node's link of a late ES module graph: one the
 * interpreter evaluates (a module a program wrote after its launch began, a
 * query's or a fragment's instance, a staged module the registry hands on),
 * with the staged modules it reaches. Node links a whole graph before any of
 * it runs: every static import resolves and loads, and every name a module
 * imports is one its module exports (ECMA-262 ResolveExport), or the import
 * rejects and no body runs.
 *
 * node-shims gives the facts (LateLinkHost: the registry's rows, the
 * resolver, the files, the interpreter's reading of a module); this decides.
 * It is a runtime module of its own (RUNTIME_ESM_LATE_MODULE, with Node's
 * CommonJS lexer), so a launch whose imports never need it never compiles it.
 */
import { cjsModuleExportNames } from './cjs-module-exports.js';
/** The launch's row bindings, read once. */
let rowBindings;
function bindingsOf(host, row) {
    if (rowBindings === undefined) {
        try {
            const parsed = JSON.parse(host.rowBindings());
            rowBindings = parsed;
        }
        catch {
            rowBindings = [];
        }
    }
    return rowBindings[row] ?? null;
}
const isModuleRow = (bindings) => Array.isArray(bindings[0]);
/** A staged module row's bindings, or null where unknown. */
function moduleFacts(host, row) {
    const bindings = bindingsOf(host, row);
    return bindings !== null && isModuleRow(bindings) ? bindings : null;
}
/** A facade row's export names, or null where unknown. */
function rowNames(host, row) {
    const bindings = bindingsOf(host, row);
    return bindings !== null && !isModuleRow(bindings) ? bindings : null;
}
/** Every late module a link has read, by URL: what an interpreted module's `export *` asks of (starConflicts). */
const lateModules = new Map();
/** The CommonJS modules' names Node's lexer found, by path. */
const commonJsNameCache = new Map();
/**
 * The names Node's loader finds in the CommonJS module at `key` before it
 * runs: a staged facade's, else Node's lexer's over its source and the
 * modules it re-exports (cjs-module-exports.ts), `default` first.
 */
export function commonJsNames(host, key) {
    const facade = host.row('commonjs', key);
    const staged = facade === -1 ? null : rowNames(host, facade);
    if (staged !== null)
        return staged;
    return [...cjsModuleExportNames(`/${key}`, { source: (path) => host.source(path.replace(/^\/+/, ''), -1), resolve: host.cjsResolve }, commonJsNameCache)];
}
/**
 * Links the late graph of the module at `key` (`url`): throws the refusal
 * of a static import anywhere in it that does not resolve or load, or of a
 * name a module of it imports that its module does not export. Answers the
 * staged modules it imports, in import order, for the caller to evaluate
 * before the interpreter does the rest.
 */
export function linkLateGraph(host, key, url) {
    const order = [];
    const late = { modules: new Map(), rows: [] };
    plan(host, key, url, new Set(), order, new Set(), late);
    checkBindings(host, late, url);
    return order;
}
/** The names the `export *`s of the interpreted module at `url` reach two different bindings of, which its namespace omits. */
export function starConflicts(host, url) {
    const late = { modules: lateModules, rows: [] };
    // A staged module the interpreter evaluates, by its file; not a query's or a fragment's instance.
    const { protocol, search, hash, pathname } = new URL(url);
    const row = protocol === 'file:' && search === '' && hash === '' ? host.row('module', decodeURIComponent(pathname).replace(/^\/+/, '')) : -1;
    const target = lateModules.has(url) ? { url } : row !== -1 ? { row } : null;
    const names = target === null ? null : exportedNames(host, late, target, new Set());
    if (target === null || names === null)
        return [];
    return names.filter((name) => resolveExport(host, late, target, name, new Set()) === AMBIGUOUS);
}
function plan(host, key, url, seen, order, checked, late) {
    if (seen.has(url))
        return;
    seen.add(url);
    const staged = host.row('module', key);
    const text = host.source(key, staged);
    if (text === null)
        return;
    // Read with the parse goal the loader gives it: an adopted staged module's, a module; another's, its format.
    const format = staged !== -1 ? 'module' : host.fileFormat(key);
    const analysis = host.requests(key, text, staged !== -1, format ?? 'detect');
    // A module its parser could not read (a syntax error, TypeScript, JSX) is
    // loaded as the interpreter loads it, for that load's error, before any
    // body runs; a staged one is the launch's own to link.
    if (analysis.unread !== undefined && staged === -1)
        host.loadUnread(key, text, format);
    // The interpreter's lists (SafeLists: no methods) are read by index.
    const bindings = analysis.bindings;
    let statics = 0;
    for (const request of analysis.requests)
        if (request.kind === 'static')
            statics++;
    const known = bindings !== undefined && bindings.imports.length === statics;
    const exports = [];
    if (known)
        for (let i = 0; i < bindings.exports.length; i++)
            exports.push(bindings.exports[i]);
    const node = { known, exports, stars: [], imports: [], reexports: [] };
    late.modules.set(url, node);
    lateModules.set(url, node);
    let at = -1;
    for (const request of analysis.requests) {
        if (request.kind !== 'static')
            continue;
        at++;
        // Checked against its attributes as the interpreter's static import checks it.
        const resolution = host.resolve(request.specifier, url, known ? bindings.types[at] : undefined);
        if (known) {
            const loads = lateTarget(host, resolution);
            for (let i = 0; i < bindings.stars.length; i++)
                if (bindings.stars[i] === at)
                    node.stars.push(loads);
            const names = [];
            const reads = bindings.imports[at];
            for (let i = 0; i < reads.length; i++)
                names.push(reads[i]);
            if (names.length > 0)
                node.imports.push({ target: loads, specifier: request.specifier, names });
            for (let i = 0; i < bindings.reexports.length; i++) {
                const entry = bindings.reexports[i];
                if (entry[1] === at)
                    node.reexports.push([entry[0], loads, entry[2]]);
            }
        }
        if (resolution.path === undefined)
            continue;
        const target = resolution.path.replace(/^\/+/, '');
        const { search, hash } = new URL(resolution.url);
        const id = host.row('module', target);
        // An unstaged module, or a query's or a fragment's instance (the interpreter's own): its closure is the late graph's too.
        if (id === -1 || search !== '' || hash !== '') {
            // What the interpreter loads as an ES module (a CommonJS module compiles when it evaluates, as Node's does).
            if (resolution.format === 'module' || resolution.format === 'detect')
                plan(host, target, resolution.url, seen, order, checked, late);
            continue;
        }
        checkLinks(host, id, seen, checked, late);
        if (!order.includes(id))
            order.push(id);
    }
}
function lateTarget(host, resolution) {
    if (resolution.format === 'builtin' && resolution.builtin !== undefined) {
        const id = host.row('builtin', resolution.builtin);
        if (id !== -1)
            return { row: id };
        const exports = host.builtin(resolution.builtin);
        return { url: resolution.url, names: ['default', ...(typeof exports === 'object' && exports !== null ? Object.keys(exports) : [])], commonjs: false };
    }
    if (resolution.path === undefined)
        return null;
    const key = resolution.path.replace(/^\/+/, '');
    const { search, hash } = new URL(resolution.url);
    if (search === '' && hash === '') {
        const id = host.row('module', key);
        if (id !== -1)
            return { row: id };
        const facade = host.row(resolution.format === 'json' ? 'json' : 'commonjs', key);
        if (facade !== -1)
            return { row: facade };
    }
    if (resolution.format === 'module' || resolution.format === 'detect')
        return { url: resolution.url };
    if (resolution.format === 'json')
        return { url: resolution.url, names: ['default'], commonjs: false };
    if (resolution.format === 'commonjs')
        return { url: resolution.url, names: commonJsNames(host, key), commonjs: true };
    return null;
}
/**
 * Throws the refusal of a static import staged row `id`'s unevaluated graph
 * makes that staging refused for good. A staging handed on (a query's or a
 * fragment's instance, which the interpreter evaluates where it is
 * imported) is planned as the late graph's own. The graph's unevaluated
 * rows go to `late`.
 */
function checkLinks(host, id, seen, checked, late) {
    const visit = (at) => {
        if (checked.has(at))
            return;
        checked.add(at);
        if (host.rowKind(at) !== 'module' || host.rowSettled(at))
            return;
        late.rows.push(at);
        for (const target of host.rowTargets(at)) {
            if (target >= 0) {
                visit(target);
                continue;
            }
            const missing = host.missing(-2 - target);
            if (missing === null)
                continue;
            if ('refusal' in missing)
                throw missing.refusal;
            const handed = new URL(missing.handedOn);
            plan(host, decodeURIComponent(handed.pathname).replace(/^\/+/, ''), missing.handedOn, seen, [], checked, late);
        }
    };
    visit(id);
}
/**
 * Each name a module of the late graph imports is one its module exports,
 * dependencies first, as Node's linker reaches them: else Node's
 * SyntaxError. A name whose module's names are not known here is the
 * interpreter's to find.
 */
function checkBindings(host, late, rootUrl) {
    const pending = new Set(late.rows);
    const visited = new Set();
    const visit = (target) => {
        if (target === null || target.names !== undefined)
            return;
        if (target.row !== undefined && !pending.has(target.row))
            return;
        const mark = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
        if (visited.has(mark))
            return;
        visited.add(mark);
        const edges = edgesOf(host, late, target);
        for (const edge of edges)
            visit(edge.target);
        for (const edge of edges) {
            for (const name of edge.names) {
                const resolution = resolveExport(host, late, edge.target, name, new Set());
                if (resolution !== null && resolution !== AMBIGUOUS)
                    continue;
                const loads = edge.target;
                const commonjs = loads !== null && (loads.row !== undefined ? host.rowKind(loads.row) === 'commonjs' : loads.names !== undefined && loads.commonjs);
                throw host.decorate(new SyntaxError(resolution === AMBIGUOUS
                    ? `The requested module '${edge.specifier}' contains conflicting star exports for name '${name}'`
                    : host.exportMessage(edge.specifier, name, commonjs)));
            }
        }
    };
    visit({ url: rootUrl });
    for (const url of late.modules.keys())
        visit({ url });
    for (const row of late.rows)
        visit({ row });
}
function edgesOf(host, late, target) {
    if (target.row === undefined)
        return late.modules.get(target.url)?.imports ?? [];
    const facts = host.rowKind(target.row) === 'module' ? moduleFacts(host, target.row) : null;
    if (facts === null)
        return [];
    return facts[2].map(([row, specifier, ...names]) => ({ target: { row }, specifier, names }));
}
/** A name its module's `export *`s reach two different bindings of. */
const AMBIGUOUS = 'ambiguous';
/** A late or staged module's own names, `export *`s and indirect entries; null where not known here. */
function factsOf(host, late, target) {
    if (target.row === undefined) {
        const node = late.modules.get(target.url);
        return node === undefined || !node.known ? null : node;
    }
    const facts = moduleFacts(host, target.row);
    if (facts === null)
        return null;
    return {
        exports: facts[0],
        stars: facts[1].map((row) => ({ row })),
        reexports: (facts[3] ?? []).map(([exported, row, name]) => [exported, { row }, name]),
    };
}
/**
 * ECMA-262 ResolveExport of `name` of `target`: its binding, null where it
 * has no such export, AMBIGUOUS where its `export *`s reach two different
 * bindings of it, undefined where its names are not known here.
 */
function resolveExport(host, late, target, name, resolving) {
    if (target === null)
        return undefined;
    if (target.names !== undefined)
        return target.names.includes(name) ? { module: `u${target.url}`, binding: name } : null;
    const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
    if (target.row !== undefined && host.rowKind(target.row) !== 'module') {
        const names = rowNames(host, target.row);
        return names === null ? undefined : names.includes(name) ? { module, binding: name } : null;
    }
    // A circular import request: nothing more to find this way.
    if (resolving.has(`${module}\0${name}`))
        return null;
    resolving.add(`${module}\0${name}`);
    const facts = factsOf(host, late, target);
    if (facts === null)
        return undefined;
    for (const [exported, from, imported] of facts.reexports) {
        if (exported !== name)
            continue;
        if (imported !== null)
            return resolveExport(host, late, from, imported, resolving);
        if (from === null)
            return undefined;
        return { module: from.row !== undefined ? `r${from.row}` : `u${from.url}`, binding: '*' };
    }
    if (facts.exports.includes(name))
        return { module, binding: name };
    if (name === 'default')
        return null;
    let found = null;
    let unknown = false;
    for (const star of facts.stars) {
        const resolution = resolveExport(host, late, star, name, resolving);
        if (resolution === AMBIGUOUS)
            return resolution;
        if (resolution === undefined)
            unknown = true;
        else if (resolution === null)
            continue;
        else if (found === null)
            found = resolution;
        else if (found.module !== resolution.module || found.binding !== resolution.binding)
            return AMBIGUOUS;
    }
    return unknown ? undefined : found;
}
/** ECMA-262 GetExportedNames of `target`: its own names, and its `export *`s' but `default`; null where not known here. */
function exportedNames(host, late, target, seen) {
    if (target === null)
        return null;
    if (target.names !== undefined)
        return target.names;
    if (target.row !== undefined && host.rowKind(target.row) !== 'module')
        return rowNames(host, target.row);
    const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
    if (seen.has(module))
        return [];
    seen.add(module);
    const facts = factsOf(host, late, target);
    if (facts === null)
        return null;
    const names = new Set(facts.exports);
    for (const star of facts.stars) {
        const starred = exportedNames(host, late, star, seen);
        if (starred === null)
            return null;
        for (const starName of starred)
            if (starName !== 'default')
                names.add(starName);
    }
    return [...names];
}
