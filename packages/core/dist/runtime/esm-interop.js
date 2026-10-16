import { bindingIdentifiers } from './binding-pattern.js';
/** The CommonJS exports object marked as an ES module's; answers the function that installs an export's getter. */
export const ESM_EXPORTS_HELPER = '(() => { const O = ({}).constructor; const tag = O.getOwnPropertySymbols(O.getPrototypeOf(async () => {}))[0]; '
    + 'return (exports) => { O.defineProperty(exports, "__esModule", { value: true, configurable: true }); O.defineProperty(exports, tag, { value: "Module" }); '
    + 'return (name, get) => O.defineProperty(exports, name, { enumerable: true, configurable: false, get }); }; })()';
/**
 * `export *`: each name of the module but `default`, those already exported
 * (enumerable: the `__esModule` marker is not, and a star replaces it as an
 * export would) and those `omitted` (ESM_CONFLICTS_HELPER's), read through.
 */
export const ESM_STAR_HELPER = '(exports, define, m, omitted) => { for (const k in m) { if (k === "default" || ({}).propertyIsEnumerable.call(exports, k)) continue; '
    + 'let left = false; for (let i = 0; omitted && i < omitted.length; i++) if (omitted[i] === k) left = true; if (!left) define(k, () => m[k]); } }';
/** What a module's require is passed for the names its `export *`s reach two different bindings of. */
export const ESM_STAR_CONFLICTS = 'nimbus:star-conflicts';
/** The names a module's `export *`s leave out, as Node's namespace omits them: its loader's answer, through its require. */
export const ESM_CONFLICTS_HELPER = `(require) => require("", "${ESM_STAR_CONFLICTS}")`;
/**
 * What a module's require is passed beside a static import's specifier: the
 * loader resolves it as Node's ESM loader does (node-shims' __requireFrom),
 * not as require() does. A require of a module takes its first argument
 * alone, as Node's does.
 */
export const ESM_STATIC_IMPORT = 'nimbus:static-import';
/** A static import's module: the importer's require, told the request is an import, with its `type` attribute (or null). */
export const ESM_LOAD_HELPER = `(require, source, type) => require(source, "${ESM_STATIC_IMPORT}", type)`;
/** The helpers as an object literal's source: what a launch compiles for its interpreter (interpreter/modules.ts ModuleHelpers). */
export const ESM_MODULE_HELPERS = `{ exports: ${ESM_EXPORTS_HELPER}, star: ${ESM_STAR_HELPER}, conflicts: ${ESM_CONFLICTS_HELPER}, load: ${ESM_LOAD_HELPER} }`;
/** A ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`. */
function exportName(node) {
    return node.type === 'Identifier' ? node.name : `${node.value}`;
}
/**
 * The attribute a static import or re-export passes its loader: its `type`,
 * or null. V8 keeps only the keys its host supports, Node's being `type`
 * alone, so any other key is dropped, not refused (import()'s are refused).
 */
export function importType(node) {
    const attributes = node.attributes ?? [];
    for (let i = 0; i < attributes.length; i++) {
        const { key, value } = attributes[i];
        if ((key.type === 'Identifier' ? key.name : key.value) === 'type' && typeof value.value === 'string')
            return value.value;
    }
    return null;
}
/** The record of a module's top-level statement, or null for one that declares no import or export. */
export function esmRecord(node, lists) {
    switch (node.type) {
        case 'ImportDeclaration': {
            const bindings = lists.list();
            for (let i = 0; i < node.specifiers.length; i++) {
                const specifier = node.specifiers[i];
                lists.push(bindings, specifier.type === 'ImportNamespaceSpecifier'
                    ? { kind: 'namespace', local: specifier.local.name }
                    : {
                        kind: 'named',
                        local: specifier.local.name,
                        imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : exportName(specifier.imported),
                    });
            }
            return { kind: 'import', start: node.start, end: node.end, source: `${node.source.value}`, type: importType(node), bindings };
        }
        case 'ExportNamedDeclaration': {
            const names = lists.list();
            const declaration = node.declaration;
            if (declaration) {
                if (declaration.type === 'VariableDeclaration') {
                    const ids = lists.list();
                    for (let i = 0; i < declaration.declarations.length; i++)
                        bindingIdentifiers(declaration.declarations[i].id, ids);
                    for (let i = 0; i < ids.length; i++)
                        lists.push(names, { kind: 'named', exported: ids[i].name, local: ids[i].name });
                }
                else {
                    lists.push(names, { kind: 'named', exported: declaration.id.name, local: declaration.id.name });
                }
                return { kind: 'export', start: node.start, end: declaration.start, source: null, type: null, names };
            }
            for (let i = 0; i < node.specifiers.length; i++) {
                const specifier = node.specifiers[i];
                lists.push(names, { kind: 'named', exported: exportName(specifier.exported), local: exportName(specifier.local) });
            }
            return { kind: 'export', start: node.start, end: node.end, source: node.source ? `${node.source.value}` : null, type: node.source ? importType(node) : null, names };
        }
        case 'ExportDefaultDeclaration': {
            const declaration = node.declaration;
            if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
                const names = lists.list();
                lists.push(names, { kind: 'named', exported: 'default', local: declaration.id.name });
                return { kind: 'export', start: node.start, end: declaration.start, source: null, type: null, names };
            }
            return { kind: 'export-default', start: node.start, end: node.end, expression: { start: declaration.start, end: declaration.end } };
        }
        case 'ExportAllDeclaration': {
            if (node.exported) {
                const names = lists.list();
                lists.push(names, { kind: 'namespace', exported: exportName(node.exported) });
                return { kind: 'export', start: node.start, end: node.end, source: `${node.source.value}`, type: importType(node), names };
            }
            return { kind: 'export-all', start: node.start, end: node.end, source: `${node.source.value}`, type: importType(node) };
        }
        default:
            return null;
    }
}
/** The link of a module whose declarations are `records`, in source order. */
export function esmLink(records, lists) {
    const exports = lists.list();
    const requests = lists.list();
    const namespaces = lists.list();
    const stars = lists.list();
    const none = lists.list();
    const request = (source, type, kept, bindings) => {
        lists.push(requests, { source, type, kept, bindings });
        return requests.length - 1;
    };
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        switch (record.kind) {
            case 'import': {
                const at = request(record.source, record.type, record.bindings.length > 0, record.bindings);
                for (let j = 0; j < record.bindings.length; j++) {
                    const binding = record.bindings[j];
                    if (binding.kind === 'namespace')
                        lists.push(namespaces, { request: at, local: binding.local });
                }
                break;
            }
            case 'export': {
                if (record.source === null) {
                    // A module's own export names a binding of its own; nothing else parses.
                    for (let j = 0; j < record.names.length; j++) {
                        const name = record.names[j];
                        if (name.kind === 'named')
                            lists.push(exports, { kind: 'binding', exported: name.exported, local: name.local });
                    }
                    break;
                }
                const at = request(record.source, record.type, true, none);
                for (let j = 0; j < record.names.length; j++) {
                    const name = record.names[j];
                    if (name.kind === 'named') {
                        lists.push(exports, { kind: 'reexport', exported: name.exported, request: at, name: name.local });
                    }
                    else {
                        lists.push(namespaces, { request: at, local: null });
                        lists.push(exports, { kind: 'namespace', exported: name.exported, namespace: namespaces.length - 1 });
                    }
                }
                break;
            }
            case 'export-default':
                lists.push(exports, { kind: 'default', exported: 'default' });
                break;
            case 'export-all':
                lists.push(stars, request(record.source, record.type, true, none));
                break;
        }
    }
    return { exports: byExportedName(exports, lists), requests, namespaces, stars };
}
/** The bindings of a module linked as `link`. */
export function esmBindings(link, lists) {
    const exports = lists.list();
    for (let i = 0; i < link.exports.length; i++)
        lists.push(exports, link.exports[i].exported);
    const imports = lists.list();
    for (let i = 0; i < link.requests.length; i++) {
        const names = lists.list();
        const bindings = link.requests[i].bindings;
        for (let j = 0; j < bindings.length; j++) {
            const binding = bindings[j];
            if (binding.kind === 'named')
                lists.push(names, binding.imported);
        }
        lists.push(imports, names);
    }
    for (let i = 0; i < link.exports.length; i++) {
        const entry = link.exports[i];
        if (entry.kind === 'reexport')
            lists.push(imports[entry.request], entry.name);
    }
    const types = lists.list();
    for (let i = 0; i < link.requests.length; i++)
        lists.push(types, link.requests[i].type);
    const reexports = lists.list();
    const locals = lists.list();
    for (let i = 0; i < link.exports.length; i++) {
        const entry = link.exports[i];
        if (entry.kind === 'reexport')
            lists.push(reexports, [entry.exported, entry.request, entry.name]);
        else if (entry.kind === 'namespace')
            lists.push(reexports, [entry.exported, link.namespaces[entry.namespace].request, null]);
        else if (entry.kind === 'default')
            lists.push(locals, [entry.exported, '*default*']);
        else {
            // An export of an imported binding is that module's.
            let imported = false;
            for (let r = 0; r < link.requests.length; r++) {
                const bindings = link.requests[r].bindings;
                for (let j = 0; j < bindings.length; j++) {
                    const binding = bindings[j];
                    if (binding.local !== entry.local)
                        continue;
                    lists.push(reexports, [entry.exported, r, binding.kind === 'named' ? binding.imported : null]);
                    imported = true;
                }
            }
            if (!imported)
                lists.push(locals, [entry.exported, entry.local]);
        }
    }
    return { exports, imports, stars: link.stars, types, reexports, locals };
}
/** `entries` sorted by exported name, stably: a merge sort, which calls nothing of the realm's. */
function byExportedName(entries, lists) {
    const n = entries.length;
    let sorted = true;
    for (let i = 1; i < n && sorted; i++)
        sorted = !(entries[i].exported < entries[i - 1].exported);
    if (sorted)
        return entries;
    let from = entries;
    let to = lists.list();
    for (let i = 0; i < n; i++)
        lists.push(to, entries[i]);
    for (let width = 1; width < n; width *= 2) {
        for (let low = 0; low < n; low += 2 * width) {
            const middle = low + width < n ? low + width : n;
            const high = low + 2 * width < n ? low + 2 * width : n;
            let i = low;
            let j = middle;
            let k = low;
            while (i < middle && j < high)
                to[k++] = from[j].exported < from[i].exported ? from[j++] : from[i++];
            while (i < middle)
                to[k++] = from[i++];
            while (j < high)
                to[k++] = from[j++];
        }
        const merged = to;
        to = from;
        from = merged;
    }
    return from;
}
