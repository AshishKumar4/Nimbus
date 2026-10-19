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
import { urlHash, urlHref, urlPathname, urlProtocol, urlSearch, urlSetPathname } from '../_shared/package-map.js';
import { arrayIncludes, dataDescriptor, decodeURIComponentOf, Error, JSONParse, mathMin, newURL, objectHasOwn, ownField, reflectDefineProperty, SafeList, SafeMap, SafeSet, setForEach, stringIncludes, stringSlice, stringStartsWith, SyntaxError, } from '../_shared/primordials.js';
import { cjsModuleExportNames } from './cjs-module-exports.js';
import { dataModule } from './esm-loader-policy.js';
function stripLeadingSlashes(path) {
    let start = 0;
    while (start < path.length && path[start] === '/')
        start++;
    return stringSlice(path, start);
}
function bindingsOf(analysis) {
    return analysis !== null && objectHasOwn(analysis, 'bindings') ? analysis['bindings'] : undefined;
}
const rowTarget = (row) => ({ row, url: undefined, names: undefined });
const moduleTarget = (url) => ({ row: undefined, url, names: undefined });
const namedTarget = (url, names, commonjs) => ({ row: undefined, url, names, commonjs });
/** The facades' export names, by row, read once. */
let facadeNames;
/** A facade row's export names, or null where unknown. */
function rowNames(host, row) {
    if (facadeNames === undefined) {
        try {
            const parsed = JSONParse(host.rowBindings());
            facadeNames = parsed;
        }
        catch {
            facadeNames = [];
        }
    }
    return objectHasOwn(facadeNames, row) ? facadeNames[row] ?? null : null;
}
/** Staged module rows as read, by row, once each. */
const rowReads = new SafeMap();
/** A staged module row's source, read once (its static imports index its targets). */
function rowRead(host, row) {
    const known = rowReads.get(row);
    if (known !== undefined)
        return known;
    const key = host.rowKey(row);
    const text = host.source(key, row);
    const analysis = text === null ? null : host.requests(key, text, true, 'module');
    const specifiers = new SafeList();
    if (analysis !== null) {
        for (let i = 0; i < analysis.requests.length; i++) {
            const request = analysis.requests[i];
            if (request.kind === 'static')
                specifiers[specifiers.length] = request.specifier;
        }
    }
    const read = { analysis, specifiers };
    rowReads.set(row, read);
    return read;
}
/** Staged module rows' facts, by row, read from their sources when a link first needs them. */
const rowFacts = new SafeMap();
/** A staged module row's facts, or null where its source does not tell them. */
function moduleFacts(host, row) {
    const known = rowFacts.get(row);
    if (known !== undefined)
        return known;
    let facts = null;
    const key = host.rowKey(row);
    const { analysis, specifiers } = rowRead(host, row);
    const bindings = bindingsOf(analysis);
    const targets = host.rowTargets(row);
    if (bindings !== undefined && bindings.imports.length === targets.length && specifiers.length === targets.length) {
        // What static import `at` loads: a row, or what staging handed it on to.
        const loads = (at) => {
            if (targets[at] >= 0)
                return rowTarget(targets[at]);
            const missing = host.missing(-2 - targets[at]);
            const handedOn = missing === null ? undefined : ownField(missing, 'handedOn');
            if (typeof handedOn !== 'string')
                return null;
            const file = handedOnFile(host, key, handedOn, specifiers[at], bindings.types[at]);
            return file === null ? handedOnTarget(handedOn) : lateTarget(host, file);
        };
        const exports = new SafeList();
        for (let i = 0; i < bindings.exports.length; i++)
            exports[exports.length] = bindings.exports[i];
        const locals = new SafeList();
        for (let i = 0; i < bindings.locals.length; i++)
            locals[locals.length] = [bindings.locals[i][0], bindings.locals[i][1]];
        const stars = new SafeList();
        for (let i = 0; i < bindings.stars.length; i++)
            stars[stars.length] = loads(bindings.stars[i]);
        const imports = new SafeList();
        for (let at = 0; at < targets.length; at++) {
            const names = new SafeList();
            for (let i = 0; i < bindings.imports[at].length; i++)
                names[names.length] = bindings.imports[at][i];
            if (names.length > 0)
                imports[imports.length] = { target: loads(at), specifier: specifiers[at], names };
        }
        const reexports = new SafeList();
        for (let i = 0; i < bindings.reexports.length; i++) {
            const entry = bindings.reexports[i];
            reexports[reexports.length] = [entry[0], loads(entry[1]), entry[2]];
        }
        facts = { exports, locals, stars, imports, reexports };
    }
    rowFacts.set(row, facts);
    return facts;
}
/**
 * The modules an import()'s link failed in, by instance (a file's path; a
 * query's, a fragment's or a data: module's URL): the module a static
 * import of did not resolve or load, and each that imports it on the way
 * from the link's root. The failure stays, as Node's loader keeps a
 * ModuleJob that did not link: a later link reaching one fails with it,
 * whatever the program wrote since.
 */
const linkFailures = new SafeMap();
/** The failure an import()'s link kept for the staged module at `key` (linkFailures): what a later load of it throws. */
export function keptFailure(key) {
    return linkFailures.get(key);
}
/** Every late module a link has read, by URL: what an interpreted module's `export *` asks of (starConflicts). */
const lateModules = new SafeMap();
/** The CommonJS modules' names Node's lexer found, by path. */
const commonJsNameCache = new SafeMap();
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
    const out = [];
    const names = cjsModuleExportNames(`/${key}`, { source: (path) => host.source(stripLeadingSlashes(path), -1), resolve: host.cjsResolve }, commonJsNameCache);
    setForEach(names, (name) => { reflectDefineProperty(out, out.length, dataDescriptor(name, true, true, true)); });
    return out;
}
/**
 * Links the late graph of the module at `key` (`url`): throws the refusal
 * of a static import anywhere in it that does not resolve or load, or of a
 * name a module of it imports that its module does not export. Answers the
 * staged modules it imports, in import order, for the caller to evaluate
 * before the interpreter does the rest.
 */
export function linkLateGraph(host, key, url, kept) {
    const order = [];
    const late = { modules: new SafeMap(), rows: new SafeList(), kept };
    plan(host, key, url, new SafeSet(), order, new SafeSet(), late);
    checkBindings(host, late, url);
    for (let i = 0; i < late.rows.length; i++)
        checkedRows.add(late.rows[i]);
    return order;
}
/** The staged rows whose graphs a link checked, every imported name in them: none is checked again. */
const checkedRows = new SafeSet();
/**
 * Links staged row `id` (its module at `key`, `url`), which the interpreter
 * adopts because workerd could not link its graph (it reaches a module
 * staging handed on, or one the interpreter took), as a late graph is
 * linked: unless a link already checked it (the late graph that imports it).
 */
export function linkAdopted(host, id, key, url) {
    if (checkedRows.has(id))
        return;
    linkLateGraph(host, key, url, true);
    checkedRows.add(id);
}
/** The names the `export *`s of the interpreted module at `url` reach two different bindings of, which its namespace omits. */
export function starConflicts(host, url) {
    const late = { modules: lateModules, rows: new SafeList(), kept: false };
    // A staged module the interpreter evaluates, by its file; not a query's or a fragment's instance.
    const parsed = newURL(url);
    const protocol = urlProtocol(parsed);
    const search = urlSearch(parsed);
    const hash = urlHash(parsed);
    const pathname = urlPathname(parsed);
    const row = protocol === 'file:' && search === '' && hash === '' ? host.row('module', stripLeadingSlashes(decodeURIComponentOf(pathname))) : -1;
    const target = lateModules.has(url) ? moduleTarget(url) : row !== -1 ? rowTarget(row) : null;
    const names = target === null ? null : exportedNames(host, late, target, new SafeSet());
    if (target === null || names === null)
        return [];
    const out = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (resolveExport(host, late, target, name, new SafeSet()) === AMBIGUOUS)
            reflectDefineProperty(out, out.length, dataDescriptor(name, true, true, true));
    }
    return out;
}
/**
 * The names of the namespace of the late module at `url`, as its link read
 * them: its own and its `export *`s', but those two of them reach different
 * bindings of; null where its link did not read them (one not linked, or
 * whose names its source does not tell). Known before its body runs, so a
 * namespace taken in a cycle has them all.
 */
export function namespaceNames(host, url) {
    const late = { modules: lateModules, rows: new SafeList(), kept: false };
    if (!lateModules.has(url))
        return null;
    const target = moduleTarget(url);
    const names = exportedNames(host, late, target, new SafeSet());
    if (names === null)
        return null;
    const out = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (resolveExport(host, late, target, name, new SafeSet()) !== AMBIGUOUS)
            reflectDefineProperty(out, out.length, dataDescriptor(name, true, true, true));
    }
    return out;
}
/**
 * Plans the late module at `url` (a file's at `key`; a data: URL's is its
 * URL): its static imports' modules, their names, and the staged rows it
 * reaches, into `late` and `order`.
 */
function plan(host, key, url, seen, order, checked, late) {
    if (seen.has(url))
        return;
    seen.add(url);
    const instance = stringStartsWith(url, 'file:') && !stringIncludes(url, '?') && !stringIncludes(url, '#') ? key : url;
    const failure = linkFailures.get(instance);
    if (failure !== undefined)
        throw failure;
    try {
        planModule(host, key, url, seen, order, checked, late);
    }
    catch (e) {
        if (late.kept && e instanceof Error)
            linkFailures.set(instance, e);
        throw e;
    }
}
function planModule(host, key, url, seen, order, checked, late) {
    // A data: URL's module is its body, an ES module (its MIME type's goal): no row, no file.
    const data = stringStartsWith(url, 'data:') ? dataModule(url) : null;
    const staged = data !== null ? -1 : host.row('module', key);
    const text = data !== null ? (data.format === 'module' ? data.source : null) : host.source(key, staged);
    if (text === null)
        return;
    // Read with the parse goal the loader gives it: an adopted staged module's, a module; another's, its format.
    const format = staged !== -1 || data !== null ? 'module' : host.fileFormat(key);
    const analysis = host.requests(key, text, staged !== -1 || data !== null, format ?? 'detect');
    // A module its parser could not read (a syntax error, TypeScript, JSX) is
    // loaded as the interpreter loads it, for that load's error, before any
    // body runs; a staged one is the launch's own to link.
    if (ownField(analysis, 'unread') !== undefined && staged === -1)
        host.loadUnread(key, text, format);
    // The interpreter's lists (SafeLists: no methods) are read by index.
    const bindings = bindingsOf(analysis);
    let statics = 0;
    for (let i = 0; i < analysis.requests.length; i++)
        if (analysis.requests[i].kind === 'static')
            statics++;
    const known = bindings !== undefined && bindings.imports.length === statics;
    const exports = new SafeList();
    const locals = new SafeList();
    if (known) {
        for (let i = 0; i < bindings.exports.length; i++)
            exports[exports.length] = bindings.exports[i];
        for (let i = 0; i < bindings.locals.length; i++)
            locals[locals.length] = [bindings.locals[i][0], bindings.locals[i][1]];
    }
    const node = { known, exports, locals, stars: new SafeList(), imports: new SafeList(), reexports: new SafeList() };
    late.modules.set(url, node);
    lateModules.set(url, node);
    let at = -1;
    for (let index = 0; index < analysis.requests.length; index++) {
        const request = analysis.requests[index];
        if (request.kind !== 'static')
            continue;
        at++;
        // Checked against its attributes as the interpreter's static import checks it.
        const resolution = host.resolve(request.specifier, url, known ? bindings.types[at] : undefined);
        if (known) {
            const loads = lateTarget(host, resolution);
            for (let i = 0; i < bindings.stars.length; i++)
                if (bindings.stars[i] === at)
                    node.stars[node.stars.length] = loads;
            const names = new SafeList();
            const reads = bindings.imports[at];
            for (let i = 0; i < reads.length; i++)
                names[names.length] = reads[i];
            if (names.length > 0)
                node.imports[node.imports.length] = { target: loads, specifier: request.specifier, names };
            for (let i = 0; i < bindings.reexports.length; i++) {
                const entry = bindings.reexports[i];
                if (entry[1] === at)
                    node.reexports[node.reexports.length] = [entry[0], loads, entry[2]];
            }
        }
        // A data: JavaScript module is the late graph's own, by its URL.
        if (resolution.format === 'data') {
            plan(host, resolution.url, resolution.url, seen, order, checked, late);
            continue;
        }
        const path = ownField(resolution, 'path');
        if (typeof path !== 'string')
            continue;
        const target = stripLeadingSlashes(path);
        const parsed = newURL(resolution.url);
        const search = urlSearch(parsed);
        const hash = urlHash(parsed);
        const id = host.row('module', target);
        // An unstaged module, or a query's or a fragment's instance (the interpreter's own): its closure is the late graph's too.
        if (id === -1 || search !== '' || hash !== '') {
            // What the interpreter loads as an ES module (a CommonJS module compiles when it evaluates, as Node's does).
            if (resolution.format === 'module' || resolution.format === 'detect')
                plan(host, target, resolution.url, seen, order, checked, late);
            continue;
        }
        checkLinks(host, id, seen, checked, late);
        if (!arrayIncludes(order, id))
            reflectDefineProperty(order, order.length, dataDescriptor(id, true, true, true));
    }
}
/**
 * A file staging handed on (one the launch lacked, did not stage as the
 * format it is, or a query's or a fragment's instance), resolved again from
 * its importer at `key` as the loader resolves it when the importer is
 * imported, checked against its `type` attribute: the module it loads is
 * its format's. Null for a data: URL. Throws Node's error where it does not
 * resolve still.
 */
function handedOnFile(host, key, url, specifier, type) {
    if (urlProtocol(newURL(url)) !== 'file:')
        return null;
    const parent = newURL('file://');
    urlSetPathname(parent, '/' + key);
    return host.resolve(specifier, urlHref(parent), type);
}
/**
 * What a module staging handed on (or a data: import) loads: a query's or a
 * fragment's instance, a late module by its URL; a data: module by its MIME
 * type, JavaScript a late module of its own, JSON its default alone.
 */
function handedOnTarget(url) {
    if (!stringStartsWith(url, 'data:'))
        return moduleTarget(url);
    const { format } = dataModule(url);
    return format === 'module' ? moduleTarget(url) : format === 'json' ? namedTarget(url, ['default'], false) : null;
}
function lateTarget(host, resolution) {
    if (resolution.format === 'builtin') {
        const builtin = ownField(resolution, 'builtin');
        if (typeof builtin === 'string') {
            const id = host.row('builtin', builtin);
            return id !== -1 ? rowTarget(id) : namedTarget(resolution.url, host.builtinNames(builtin), false);
        }
    }
    if (resolution.format === 'data')
        return handedOnTarget(resolution.url);
    const path = ownField(resolution, 'path');
    if (typeof path !== 'string')
        return null;
    const key = stripLeadingSlashes(path);
    const parsed = newURL(resolution.url);
    const search = urlSearch(parsed);
    const hash = urlHash(parsed);
    if (search === '' && hash === '') {
        const id = host.row('module', key);
        if (id !== -1)
            return rowTarget(id);
        const facade = host.row(resolution.format === 'json' ? 'json' : 'commonjs', key);
        if (facade !== -1)
            return rowTarget(facade);
    }
    if (resolution.format === 'module' || resolution.format === 'detect')
        return moduleTarget(resolution.url);
    if (resolution.format === 'json')
        return namedTarget(resolution.url, ['default'], false);
    if (resolution.format === 'commonjs')
        return namedTarget(resolution.url, commonJsNames(host, key), true);
    return null;
}
/**
 * Throws the refusal of a static import staged row `id`'s unevaluated graph
 * makes that staging refused for good. A staging handed on (a query's or a
 * fragment's instance, which the interpreter evaluates where it is
 * imported) is planned as the late graph's own. The graph's unevaluated
 * rows go to `late`. A require() staging hoisted (a target past the row's
 * static imports) is not followed: the interpreter evaluates the row's own
 * text, whose require() links its module where it runs, as Node's does,
 * after the row's static imports evaluate (which may write its files).
 */
function checkLinks(host, id, seen, checked, late) {
    if (checked.has(id))
        return;
    checked.add(id);
    if (host.rowKind(id) !== 'module' || host.rowSettled(id))
        return;
    const failure = linkFailures.get(host.rowKey(id));
    if (failure !== undefined)
        throw failure;
    try {
        late.rows[late.rows.length] = id;
        const { analysis, specifiers } = rowRead(host, id);
        const targets = host.rowTargets(id).length;
        const statics = analysis === null ? targets : mathMin(specifiers.length, targets);
        for (let index = 0; index < statics; index++)
            checkTarget(host, id, index, seen, checked, late);
    }
    catch (e) {
        if (late.kept && e instanceof Error)
            linkFailures.set(host.rowKey(id), e);
        throw e;
    }
}
/** Throws the refusal of staged row `row`'s target `index`, as checkLinks does; what it loads goes to `late`. */
function checkTarget(host, row, index, seen, checked, late) {
    const target = host.rowTargets(row)[index];
    if (target >= 0) {
        checkLinks(host, target, seen, checked, late);
        return;
    }
    const missing = host.missing(-2 - target);
    if (missing === null)
        return;
    if (objectHasOwn(missing, 'refusal'))
        throw ownField(missing, 'refusal');
    // A file handed on is resolved now, as the loader resolves it when the
    // module is imported (Node's error if it is missing still), and planned
    // as an unstaged module is: a JSON or CommonJS file has no links.
    const { analysis, specifiers } = rowRead(host, row);
    const specifier = specifiers[index];
    const handedOn = ownField(missing, 'handedOn');
    if (typeof handedOn !== 'string')
        return;
    const bindings = bindingsOf(analysis);
    const file = specifier === undefined ? null : handedOnFile(host, host.rowKey(row), handedOn, specifier, bindings?.types[index]);
    if (file !== null) {
        const path = ownField(file, 'path');
        if (typeof path === 'string' && (file.format === 'module' || file.format === 'detect'))
            plan(host, stripLeadingSlashes(path), file.url, seen, [], checked, late);
        return;
    }
    // A query's or a fragment's file by its path; a data: module by its URL.
    const handed = newURL(handedOn);
    const key = urlProtocol(handed) === 'data:' ? handedOn : stripLeadingSlashes(decodeURIComponentOf(urlPathname(handed)));
    plan(host, key, handedOn, seen, [], checked, late);
}
/**
 * Each name a module of the late graph imports is one its module exports,
 * dependencies first, as Node's linker reaches them: else Node's
 * SyntaxError. A name whose module's names are not known here is the
 * interpreter's to find.
 */
function checkBindings(host, late, rootUrl) {
    const pending = new SafeSet();
    for (let i = 0; i < late.rows.length; i++)
        pending.add(late.rows[i]);
    const visited = new SafeSet();
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
        for (let i = 0; i < edges.length; i++)
            visit(edges[i].target);
        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            for (let n = 0; n < edge.names.length; n++) {
                const name = edge.names[n];
                const resolution = resolveExport(host, late, edge.target, name, new SafeSet());
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
    visit(moduleTarget(rootUrl));
    late.modules.forEach((_node, url) => { visit(moduleTarget(url)); });
    for (let i = 0; i < late.rows.length; i++)
        visit(rowTarget(late.rows[i]));
}
function edgesOf(host, late, target) {
    if (target.row === undefined)
        return late.modules.get(target.url)?.imports ?? [];
    const facts = host.rowKind(target.row) === 'module' ? moduleFacts(host, target.row) : null;
    return facts === null ? [] : facts.imports;
}
/** A name its module's `export *`s reach two different bindings of. */
const AMBIGUOUS = 'ambiguous';
/**
 * A late or staged module's facts; null where not known here. A late module
 * an earlier link read (a query's instance a staged module, already run,
 * hands on) is that link's.
 */
function factsOf(host, late, target) {
    if (target.row === undefined) {
        const node = late.modules.get(target.url) ?? lateModules.get(target.url);
        return node === undefined || !node.known ? null : node;
    }
    return moduleFacts(host, target.row);
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
        return arrayIncludes(target.names, name) ? { module: `u${target.url}`, binding: name } : null;
    const module = target.row !== undefined ? `r${target.row}` : `u${target.url}`;
    if (target.row !== undefined && host.rowKind(target.row) !== 'module') {
        const names = rowNames(host, target.row);
        return names === null ? undefined : arrayIncludes(names, name) ? { module, binding: name } : null;
    }
    // A circular import request: nothing more to find this way.
    if (resolving.has(`${module}\0${name}`))
        return null;
    resolving.add(`${module}\0${name}`);
    const facts = factsOf(host, late, target);
    if (facts === null)
        return undefined;
    for (let i = 0; i < facts.reexports.length; i++) {
        const entry = facts.reexports[i];
        if (entry[0] !== name)
            continue;
        const from = entry[1];
        const imported = entry[2];
        if (imported !== null)
            return resolveExport(host, late, from, imported, resolving);
        if (from === null)
            return undefined;
        return { module: from.row !== undefined ? `r${from.row}` : `u${from.url}`, binding: '*' };
    }
    for (let i = 0; i < facts.locals.length; i++) {
        const entry = facts.locals[i];
        if (entry[0] === name)
            return { module, binding: entry[1] };
    }
    if (name === 'default')
        return null;
    let found = null;
    let incomplete = false;
    for (let i = 0; i < facts.stars.length; i++) {
        const resolution = resolveExport(host, late, facts.stars[i], name, resolving);
        if (resolution === AMBIGUOUS)
            return resolution;
        if (resolution === undefined)
            incomplete = true;
        else if (resolution === null)
            continue;
        else if (found === null)
            found = resolution;
        else if (found.module !== resolution.module || found.binding !== resolution.binding)
            return AMBIGUOUS;
    }
    return incomplete ? undefined : found;
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
    const names = new SafeSet();
    for (let i = 0; i < facts.exports.length; i++)
        names.add(facts.exports[i]);
    for (let i = 0; i < facts.stars.length; i++) {
        const starred = exportedNames(host, late, facts.stars[i], seen);
        if (starred === null)
            return null;
        for (let n = 0; n < starred.length; n++)
            if (starred[n] !== 'default')
                names.add(starred[n]);
    }
    const out = new SafeList();
    names.forEach((name) => { out[out.length] = name; });
    return out;
}
