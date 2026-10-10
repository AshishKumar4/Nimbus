import { forEachBindingIdentifier } from './binding-pattern.js';
/** The CommonJS exports object marked as an ES module's; answers the function that installs an export's getter. */
export const ESM_EXPORTS_HELPER = '(() => { const O = ({}).constructor; const tag = O.getOwnPropertySymbols(O.getPrototypeOf(async () => {}))[0]; '
    + 'return (exports) => { O.defineProperty(exports, "__esModule", { value: true }); O.defineProperty(exports, tag, { value: "Module" }); '
    + 'return (name, get) => O.defineProperty(exports, name, { enumerable: true, get }); }; })()';
/** What a default import reads `default` of: the module when it is marked `__esModule`, else `{ default: module }`. */
export const ESM_INTEROP_HELPER = '(m) => m && m.__esModule ? m : { default: m }';
/**
 * A required module as a namespace, as Node and esbuild read a CommonJS
 * module: one marked `__esModule` as it is; any other with its exports as
 * `default`, its other own names read through.
 */
export const ESM_NAMESPACE_HELPER = '(m) => { if (m && m.__esModule) return m; const O = ({}).constructor; '
    + 'const ns = O.create(m != null ? O.getPrototypeOf(m) : null); O.defineProperty(ns, "default", { value: m, enumerable: true }); '
    + 'if (m != null) for (const k of O.getOwnPropertyNames(m)) if (k !== "default") '
    + 'O.defineProperty(ns, k, { get: () => m[k], enumerable: O.getOwnPropertyDescriptor(m, k).enumerable }); return ns; }';
/** `export *`: each name of the module but `default` and those already exported, read through. */
export const ESM_STAR_HELPER = '(exports, define, m) => { for (const k in m) if (k !== "default" && !({}).hasOwnProperty.call(exports, k)) define(k, () => m[k]); }';
/** The four helpers as an object literal's source: what a launch compiles for its interpreter (interpreter/modules.ts ModuleHelpers). */
export const ESM_MODULE_HELPERS = `{ exports: ${ESM_EXPORTS_HELPER}, interop: ${ESM_INTEROP_HELPER}, namespace: ${ESM_NAMESPACE_HELPER}, star: ${ESM_STAR_HELPER} }`;
/** A ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`. */
function exportName(node) {
    return node.type === 'Identifier' ? node.name : `${node.value}`;
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
            return { kind: 'import', start: node.start, end: node.end, source: `${node.source.value}`, bindings };
        }
        case 'ExportNamedDeclaration': {
            const names = lists.list();
            const declaration = node.declaration;
            if (declaration) {
                if (declaration.type === 'VariableDeclaration') {
                    for (let i = 0; i < declaration.declarations.length; i++) {
                        forEachBindingIdentifier(declaration.declarations[i].id, (id) => lists.push(names, { kind: 'named', exported: id.name, local: id.name }));
                    }
                }
                else {
                    lists.push(names, { kind: 'named', exported: declaration.id.name, local: declaration.id.name });
                }
                return { kind: 'export', start: node.start, end: declaration.start, source: null, names };
            }
            for (let i = 0; i < node.specifiers.length; i++) {
                const specifier = node.specifiers[i];
                lists.push(names, { kind: 'named', exported: exportName(specifier.exported), local: exportName(specifier.local) });
            }
            return { kind: 'export', start: node.start, end: node.end, source: node.source ? `${node.source.value}` : null, names };
        }
        case 'ExportDefaultDeclaration': {
            const declaration = node.declaration;
            if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
                const names = lists.list();
                lists.push(names, { kind: 'named', exported: 'default', local: declaration.id.name });
                return { kind: 'export', start: node.start, end: declaration.start, source: null, names };
            }
            return { kind: 'export-default', start: node.start, end: node.end, expression: { start: declaration.start, end: declaration.end } };
        }
        case 'ExportAllDeclaration': {
            if (node.exported) {
                const names = lists.list();
                lists.push(names, { kind: 'namespace', exported: exportName(node.exported) });
                return { kind: 'export', start: node.start, end: node.end, source: `${node.source.value}`, names };
            }
            return { kind: 'export-all', start: node.start, end: node.end, source: `${node.source.value}` };
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
    const request = (source, kept, interop, bindings) => {
        lists.push(requests, { source, kept, interop, bindings });
        return requests.length - 1;
    };
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        switch (record.kind) {
            case 'import': {
                let interop = false;
                for (let j = 0; j < record.bindings.length; j++) {
                    const binding = record.bindings[j];
                    if (binding.kind === 'named' && binding.imported === 'default')
                        interop = true;
                }
                const at = request(record.source, record.bindings.length > 0, interop, record.bindings);
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
                const at = request(record.source, true, false, none);
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
                lists.push(stars, request(record.source, true, false, none));
                break;
        }
    }
    return { exports: byExportedName(exports, lists), requests, namespaces, stars };
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
