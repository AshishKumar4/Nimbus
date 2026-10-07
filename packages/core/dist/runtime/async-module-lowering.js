import { applySourceEdits, MODULE_PARSE_OPTIONS, parseStatements } from './javascript-ast.js';
import { bindingScope, list, namesBinding, scoped, stringOf } from './javascript-scope.js';
/**
 * Names for code generated around `source`: a prefix its text does not hold
 * anywhere, then a number, so no binding of the source is one of them.
 */
export function generatedNames(source) {
    let prefix = '__nimbus_m';
    while (source.includes(prefix))
        prefix += '_';
    let count = 0;
    return () => `${prefix}${count++}`;
}
/** `esm` lowered to the CommonJS function body of an async module. */
export function lowerAsyncModule(esm) {
    return emitCommonJs(esm, readEsmRecords(esm), { body: 'async' });
}
/**
 * The import and export declarations of ES module `source`, in source order,
 * each named import binding with where the module uses it (EsmReference).
 * Throws on a syntax error.
 *
 * A use is an identifier no scope inside the module binds again: not a
 * member's, a key's or a label's name, or a declaration's own (an import
 * name cannot be redeclared at the top level). Each function is analyzed as
 * the parse finishes it, its uses of the names imported so far kept (those
 * its own scopes leave free) and its body dropped; a top-level statement's
 * uses are resolved the same way, through its functions' free uses. Imports
 * come first in nearly every module, so one parse does; a module importing
 * a name after code that may use it is parsed again, every name known.
 */
export function readEsmRecords(source) {
    const first = readModule(source, null);
    return first.importsAfterCode ? readModule(source, first.imported).records : first.records;
}
function readModule(source, known) {
    // ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`.
    const nameOf = (node) => node.type === 'Identifier' ? String(node.name) : String(node.value);
    const imported = new Set(known ?? []);
    const records = [];
    const uses = new Map();
    let code = false;
    let importsAfterCode = false;
    const outside = { names: new Set(), parent: null };
    // Where an identifier spelled as an imported name starts, in order: code
    // with none in it uses no import, and is not walked.
    const mentions = [];
    const mentioned = (start, end) => {
        let low = 0;
        let high = mentions.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (mentions[middle] < start)
                low = middle + 1;
            else
                high = middle;
        }
        return low < mentions.length && mentions[low] < end;
    };
    // Each function's uses its own scopes leave free.
    const freeIn = new WeakMap();
    const freeUses = (root) => {
        const own = freeIn.get(root);
        if (own)
            return own;
        const free = [];
        if (!mentioned(root.start, root.end))
            return free;
        // A pattern's properties, as the walk reaches them: a value there is written.
        const patternProperties = new Set();
        for (const [node, scope, parent, key] of scoped(root, outside, false, false, null, '', (n) => n !== root && freeIn.has(n))) {
            const inner = node === root ? undefined : freeIn.get(node);
            if (inner) {
                for (const use of inner)
                    if (bindingScope(scope, use.name) === null)
                        free.push(use);
                continue;
            }
            if (node.type === 'ObjectPattern')
                for (const property of list(node, 'properties'))
                    patternProperties.add(property);
            const name = node.type === 'Identifier' ? stringOf(node, 'name') : null;
            if (name === null || !imported.has(name) || parent === null || !namesBinding(parent, key))
                continue;
            if (bindingScope(scope, name) !== null)
                continue;
            free.push({ name, start: node.start, end: node.end, use: useOf(parent, key, patternProperties) });
        }
        return free;
    };
    const onIdentifier = (identifier) => {
        const name = stringOf(identifier, 'name');
        if (name === null || !imported.has(name))
            return;
        // Identifiers finish in source order; one out of it is put in its place.
        let at = mentions.length;
        while (at > 0 && mentions[at - 1] > identifier.start)
            at--;
        mentions.splice(at, 0, identifier.start);
    };
    const onStatement = (node) => {
        if (node.type !== 'ImportDeclaration') {
            // A top-level statement's free uses are its imports' (none redeclares one).
            for (const { name, start, end, use } of freeUses(node)) {
                const found = uses.get(name) ?? [];
                uses.set(name, found);
                found.push({ start, end, use });
            }
        }
        switch (node.type) {
            case 'ImportDeclaration': {
                for (const specifier of node.specifiers) {
                    if (specifier.type === 'ImportNamespaceSpecifier')
                        continue;
                    if (code && !imported.has(specifier.local.name))
                        importsAfterCode = true;
                    imported.add(specifier.local.name);
                }
                records.push({
                    kind: 'import', start: node.start, end: node.end, source: String(node.source.value),
                    bindings: node.specifiers.map((specifier) => (specifier.type === 'ImportNamespaceSpecifier'
                        ? { kind: 'namespace', local: specifier.local.name }
                        : {
                            kind: 'named',
                            local: specifier.local.name,
                            imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(specifier.imported),
                            // Filled in below, once every statement has been read.
                            references: [],
                        })),
                });
                return;
            }
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
        code = true;
    };
    parseStatements(source, MODULE_PARSE_OPTIONS, {
        onStatement: (statement) => onStatement(statement),
        onNode: (node) => {
            if (node.type === 'Identifier')
                onIdentifier(node);
            // A function, once finished: its free uses, before its body is dropped.
            else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
                freeIn.set(node, freeUses(node));
        },
    });
    const withUses = records.map((record) => record.kind !== 'import' ? record : {
        ...record,
        bindings: record.bindings.map((binding) => binding.kind === 'namespace' ? binding : { ...binding, references: uses.get(binding.local) ?? [] }),
    });
    return { records: withUses, imported, importsAfterCode };
}
/** How an identifier under `parent` by `key` uses the binding it names. */
function useOf(parent, key, patternProperties) {
    switch (parent.type) {
        case 'AssignmentExpression':
        case 'AssignmentPattern':
        case 'ForInStatement':
        case 'ForOfStatement':
            return key === 'left' ? 'write' : 'read';
        case 'UpdateExpression':
        case 'ArrayPattern':
        case 'RestElement':
            return 'write';
        case 'Property':
            if (key !== 'value')
                return 'read';
            if (patternProperties.has(parent))
                return 'write';
            return parent.shorthand === true ? 'shorthand' : 'read';
        case 'CallExpression':
            return key === 'callee' ? 'call' : 'read';
        case 'TaggedTemplateExpression':
            return key === 'tag' ? 'call' : 'read';
        default:
            return 'read';
    }
}
/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export function emitCommonJs(source, records, options) {
    const temp = options.names ?? generatedNames(source);
    const key = (name) => `[${JSON.stringify(name)}]`;
    // The wrapper's top level holds only generated names (these helpers, and
    // the require every record calls): in an async body the module's own
    // bindings, its imports' included, are inside the IIFE, so nothing it
    // declares (`import Object from "dep"`, `const require = createRequire(...)`)
    // reaches what these read.
    const requireRef = temp();
    const requireOf = (specifier) => `${requireRef}(${JSON.stringify(specifier)})`;
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
    // Before anything is emitted, since an export may name an import declared
    // after it: each import's module and, where it binds `default`, its
    // interop (the module if marked `__esModule`, else `{ default: module }`);
    // what the body reads for each named binding; and the edit to each use.
    const importModules = new Map();
    const reads = new Map();
    const uses = [];
    for (const record of records) {
        if (record.kind !== 'import' || record.bindings.length === 0)
            continue;
        const mod = temp();
        const interop = record.bindings.some((binding) => binding.kind === 'named' && binding.imported === 'default') ? temp() : null;
        importModules.set(record, { mod, interop });
        for (const binding of record.bindings) {
            if (binding.kind === 'namespace')
                continue;
            const read = binding.imported === 'default' ? `${interop}.default` : `${mod}${key(binding.imported)}`;
            reads.set(binding.local, read);
            for (const { start, end, use } of binding.references) {
                if (use === 'write')
                    continue;
                uses.push({ start, end, text: use === 'call' ? `(0, ${read})` : use === 'shorthand' ? `${binding.local}: ${read}` : read });
            }
        }
    }
    const defaultExpressionUses = new Set();
    // In the body's scope, before it: a getter per export name in name order;
    // then, in source order, each requested module; then the bindings an
    // import declares (a namespace; a const a write to the import throws on,
    // as the language's assignment to an import does); then each `export *`'s
    // names.
    const requires = [];
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
                const module = importModules.get(record);
                if (!module) {
                    requires.push(`${requireOf(record.source)};`);
                    break;
                }
                const { mod, interop } = module;
                requires.push(`const ${mod} = ${requireOf(record.source)};`);
                if (interop)
                    requires.push(`const ${interop} = ${mod} && ${mod}.__esModule ? ${mod} : { default: ${mod} };`);
                for (const binding of record.bindings) {
                    const { local } = binding;
                    if (binding.kind === 'namespace')
                        imported.push(`const ${local} = ${namespace(mod)};`);
                    else if (binding.references.some(({ use }) => use === 'write'))
                        imported.push(`const ${local} = void 0;`);
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
                        getters.push([name.exported, reads.get(name.local) ?? name.local]);
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
                const { start, end } = record.expression;
                const within = uses.filter((use) => use.start >= start && use.end <= end);
                for (const use of within)
                    defaultExpressionUses.add(use);
                const expression = applySourceEdits(source.slice(start, end), within.map((use) => ({ ...use, start: use.start - start, end: use.end - start })));
                edits.push({
                    start: record.start, end: record.end,
                    // Through a property named default, an anonymous function or class
                    // is named `default`, as the language names an exported one.
                    text: `var ${value} = ({ default: (${expression}) }).default;`,
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
    if (requires.length > 0)
        header.push(`const ${requireRef} = (specifier) => ${options.requireFunction ?? 'require'}(specifier);`);
    const installed = getters
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([exported, value]) => `${exportGetter}(${JSON.stringify(exported)}, () => ${value});`);
    const prologue = [...installed, ...requires, ...imported, ...stars].join(' ');
    const body = applySourceEdits(source, [...edits, ...uses.filter((use) => !defaultExpressionUses.has(use))]);
    return options.body === 'async'
        ? `${header.join('\n')}\nreturn (async () => { ${prologue}\n${body}\n})();\n`
        : `${header.join('\n')}\n${prologue}\n${body}\n`;
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
