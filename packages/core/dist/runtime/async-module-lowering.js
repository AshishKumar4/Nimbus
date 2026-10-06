/**
 * ES module to CommonJS: the one emitter of the import/export interop every
 * Nimbus lowering shares, and its two module readers.
 *
 * A module's imports and exports are read into records (readEsmRecords, by
 * acorn's module parse; the bounded bundle rewrite builds its own from the
 * declarations it found, esbuild-service.ts), and emitCommonJs writes the
 * CommonJS for them, as esbuild's and TypeScript's CommonJS output behave:
 *   - every module the source requests is required in source order, before
 *     the body; an import's bindings are read off its module (a default
 *     import through `__esModule` interop, and a namespace of a module not
 *     marked `__esModule` with that module as its `default`);
 *   - `__esModule` is a non-enumerable `true`, and each export is a live,
 *     enumerable getter installed before the body runs, in name order, so a
 *     binding the body assigns later (`export let db; db = await connect()`)
 *     reads as assigned; `export default <expression>` evaluates where it
 *     stands, into a binding its getter reads;
 *   - `export *` copies the source module's names after the module's own,
 *     skipping `default` and any name already exported: the module's own
 *     names, and an earlier `export *`'s, win.
 *
 * Two bodies: `async` runs the module in an async IIFE, the body the
 * CommonJS cell gives a module with top-level await (the transform refuses
 * `format: 'cjs'` for it, so it emits ESM and this lowers that); `sync` is
 * the module's own statements at the wrapper's top level.
 *
 * Acorn's parse gives the declarations: esbuild prints an import or export
 * clause across several lines when it is long (serve 14's `import {\n
 * resolve as resolvePath, ... } from "node:path"`), so no line or text
 * pattern can stand in for it.
 *
 * Runs in the transform facet (installed by oxc-facet/preamble.ts), in
 * esbuild-service.ts, and in the shell's `node` command.
 */
import { Parser } from 'acorn';
import { applySourceEdits } from './javascript-ast.js';
/** `esm` lowered to the CommonJS function body of an async module. */
export function lowerAsyncModule(esm) {
    return emitCommonJs(esm, readEsmRecords(esm), { body: 'async' });
}
/** The import and export declarations of ES module `source`, in source order. Throws on a syntax error. */
export function readEsmRecords(source) {
    const program = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    // ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`.
    const nameOf = (node) => node.type === 'Identifier' ? String(node.name) : String(node.value);
    const records = [];
    for (const node of program.body) {
        switch (node.type) {
            case 'ImportDeclaration':
                records.push({
                    kind: 'import', start: node.start, end: node.end, source: String(node.source.value),
                    bindings: node.specifiers.map((specifier) => (specifier.type === 'ImportNamespaceSpecifier'
                        ? { kind: 'namespace', local: specifier.local.name }
                        : {
                            kind: 'named',
                            local: specifier.local.name,
                            imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(specifier.imported),
                        })),
                });
                break;
            case 'ExportNamedDeclaration':
                if (node.declaration) {
                    records.push({
                        kind: 'export', start: node.start, end: node.declaration.start, source: null,
                        names: declaredNames(node.declaration).map((name) => ({ kind: 'named', exported: name, local: name })),
                    });
                }
                else {
                    records.push({
                        kind: 'export', start: node.start, end: node.end, source: node.source ? String(node.source.value) : null,
                        names: node.specifiers.map((s) => ({ kind: 'named', exported: nameOf(s.exported), local: nameOf(s.local) })),
                    });
                }
                break;
            case 'ExportDefaultDeclaration': {
                const declaration = node.declaration;
                if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
                    records.push({
                        kind: 'export', start: node.start, end: declaration.start, source: null,
                        names: [{ kind: 'named', exported: 'default', local: declaration.id.name }],
                    });
                }
                else {
                    records.push({
                        kind: 'export-default', start: node.start, end: node.end,
                        expression: { start: declaration.start, end: declaration.end },
                    });
                }
                break;
            }
            case 'ExportAllDeclaration':
                if (node.exported) {
                    records.push({
                        kind: 'export', start: node.start, end: node.end, source: String(node.source.value),
                        names: [{ kind: 'namespace', exported: nameOf(node.exported) }],
                    });
                }
                else {
                    records.push({ kind: 'export-all', start: node.start, end: node.end, source: String(node.source.value) });
                }
                break;
            default:
                break;
        }
    }
    return records;
}
/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export function emitCommonJs(source, records, options) {
    let prefix = '__nimbus_m';
    while (source.includes(prefix))
        prefix += '_';
    let temps = 0;
    const temp = () => `${prefix}${temps++}`;
    const key = (name) => `[${JSON.stringify(name)}]`;
    const requireFunction = options.requireFunction ?? 'require';
    const requireOf = (specifier) => `${requireFunction}(${JSON.stringify(specifier)})`;
    // The wrapper's top level holds only generated names (its records and
    // these): in an async body the module's own bindings, its imports'
    // included, are inside the IIFE, so nothing it declares (`import Object
    // from "dep"`) reaches what these read.
    const exportsRef = temp();
    const exportGetter = temp();
    const ownKey = temp();
    const namespaceOf = temp();
    let namespaces = false;
    /** A required module's namespace: an __esModule one as it is, any other with `default` = its exports. */
    const namespace = (mod) => {
        namespaces = true;
        return `${namespaceOf}(${mod})`;
    };
    // In source order, before the body: each requested module.
    const requires = [];
    // After them, in the body's scope: the imports' bindings, read off their
    // modules, then a getter per export name in name order (a module
    // namespace's), then each `export *`'s names.
    const imported = [];
    const getters = [];
    const stars = [];
    const edits = [...(options.edits ?? [])];
    let exportsAnything = false;
    // A hashbang is only valid as the first line of a script; the body moves
    // into a function. Kept as a comment so line numbers stay put.
    if (source.startsWith('#!'))
        edits.push({ start: 0, end: 2, text: '//' });
    for (const record of records) {
        switch (record.kind) {
            case 'import': {
                edits.push({ start: record.start, end: record.end, text: '' });
                if (record.bindings.length === 0) {
                    requires.push(`${requireOf(record.source)};`);
                    break;
                }
                const mod = temp();
                requires.push(`const ${mod} = ${requireOf(record.source)};`);
                for (const binding of record.bindings) {
                    const { local } = binding;
                    if (binding.kind === 'namespace')
                        imported.push(`const ${local} = ${namespace(mod)};`);
                    else if (binding.imported === 'default')
                        imported.push(`const ${local} = ${mod} && ${mod}.__esModule ? ${mod}.default : ${mod};`);
                    else
                        imported.push(`const ${local} = ${mod}${key(binding.imported)};`);
                }
                break;
            }
            case 'export': {
                exportsAnything = true;
                edits.push({ start: record.start, end: record.end, text: '' });
                if (record.source === null) {
                    for (const name of record.names) {
                        // A module's own export names a binding of its own; nothing else parses.
                        if (name.kind !== 'named')
                            throw new Error(`export of the namespace ${name.exported} without a source module`);
                        getters.push([name.exported, name.local]);
                    }
                    break;
                }
                const mod = temp();
                requires.push(`const ${mod} = ${requireOf(record.source)};`);
                for (const name of record.names) {
                    getters.push([name.exported, name.kind === 'namespace' ? namespace(mod) : `${mod}${key(name.local)}`]);
                }
                break;
            }
            case 'export-default': {
                exportsAnything = true;
                const value = temp();
                edits.push({
                    start: record.start, end: record.end,
                    // Through a property named default, an anonymous function or class
                    // is named `default`, as the language names an exported one.
                    text: `var ${value} = ({ default: (${source.slice(record.expression.start, record.expression.end)}) }).default;`,
                });
                getters.push(['default', value]);
                break;
            }
            case 'export-all': {
                exportsAnything = true;
                const mod = temp();
                edits.push({ start: record.start, end: record.end, text: '' });
                requires.push(`const ${mod} = ${requireOf(record.source)};`);
                stars.push(`for (const k in ${mod}) if (k !== "default" && !${ownKey}(${exportsRef}, k)) ${exportGetter}(k, () => ${mod}[k]);`);
                break;
            }
        }
    }
    // Object is reached through a literal: in a sync body these lines share
    // the module's scope, where it may declare a binding of that name.
    const header = exportsAnything
        ? [
            `const ${exportsRef} = ${options.exportsObject ?? 'module.exports'}; ({}).constructor.defineProperty(${exportsRef}, "__esModule", { value: true });`,
            `const ${exportGetter} = (name, get) => ({}).constructor.defineProperty(${exportsRef}, name, { enumerable: true, get });`,
            `const ${ownKey} = (o, k) => ({}).hasOwnProperty.call(o, k);`,
        ]
        : [];
    // As Node and esbuild read a CommonJS module as a namespace: its exports
    // object is `default`, its other names read through.
    if (namespaces) {
        header.push(`const ${namespaceOf} = (m) => { if (m && m.__esModule) return m; const O = ({}).constructor; ` +
            `const ns = O.create(m != null ? O.getPrototypeOf(m) : null); O.defineProperty(ns, "default", { value: m, enumerable: true }); ` +
            `if (m != null) for (const k of O.getOwnPropertyNames(m)) if (k !== "default") O.defineProperty(ns, k, { get: () => m[k], enumerable: O.getOwnPropertyDescriptor(m, k).enumerable }); return ns; };`);
    }
    const installed = getters
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([exported, value]) => `${exportGetter}(${JSON.stringify(exported)}, () => ${value});`);
    const prologue = [...imported, ...installed, ...stars].join(' ');
    const body = applySourceEdits(source, edits);
    return options.body === 'async'
        ? `${[...header, ...requires].join('\n')}\nreturn (async () => { ${prologue}\n${body}\n})();\n`
        : `${[...header, ...requires].join('\n')}\n${prologue}\n${body}\n`;
}
/** The bindings an exported declaration introduces. */
function declaredNames(declaration) {
    if (declaration.type !== 'VariableDeclaration')
        return declaration.id ? [declaration.id.name] : [];
    const names = [];
    const visit = (pattern) => {
        if (pattern === null)
            return;
        switch (pattern.type) {
            case 'Identifier':
                names.push(pattern.name);
                break;
            case 'ObjectPattern':
                for (const property of pattern.properties)
                    visit(property.type === 'RestElement' ? property.argument : property.value);
                break;
            case 'ArrayPattern':
                for (const element of pattern.elements)
                    visit(element);
                break;
            case 'RestElement':
                visit(pattern.argument);
                break;
            case 'AssignmentPattern':
                visit(pattern.left);
                break;
            default: break;
        }
    };
    for (const declarator of declaration.declarations ?? [])
        visit(declarator.id);
    return names;
}
