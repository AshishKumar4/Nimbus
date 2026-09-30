/**
 * Lower an ES module with top-level await to a CommonJS function body.
 *
 * esbuild refuses `format: 'cjs'` for top-level await, so the transform first
 * emits the module as ESM (TypeScript, JSX and defines already applied) and
 * this turns that output into the body the CommonJS cell runs: every import
 * declaration becomes a require above an async IIFE holding the rest, and each
 * export becomes an assignment to `module.exports`. Acorn's module parse gives
 * the declarations; esbuild prints an import or export clause across several
 * lines when it is long (serve 14's `import {\n resolve as resolvePath, ... }
 * from "node:path"`), so no line or text pattern can stand in for it.
 *
 * Imports and exports follow Node's interop (esm-interop.ts): a module
 * imported from CommonJS has module.exports as its default, one imported
 * from a lowered ES module its own default, and this module's exports carry
 * the ES module marker, plus `__esModule` when it exports a default.
 *
 * Runs in the esbuild facet (installed by esbuild-cli/preamble.ts) and, for
 * in-process transforms, in esbuild-service.ts.
 */
import { Parser } from 'acorn';
import { markEsmNamespaceSource, namespaceHelperSource } from './esm-interop.js';
export function lowerAsyncModule(esm) {
    const program = Parser.parse(esm, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    let prefix = '__nimbus_m';
    while (esm.includes(prefix))
        prefix += '_';
    let temps = 0;
    const temp = () => `${prefix}${temps++}`;
    const key = (name) => `[${JSON.stringify(name)}]`;
    // ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`.
    const nameOf = (node) => node.type === 'Identifier' ? String(node.name) : String(node.value);
    // The namespace an import sees: a lowered ES module's exports as they
    // are, or CommonJS with module.exports as its default and its names live.
    const namespace = `${prefix}ns`;
    const imported = (node) => `${namespace}(require(${JSON.stringify(String(node.value))}))`;
    let exportsDefault = false;
    const requires = [];
    const edits = [];
    // A hashbang is only valid as the first line of a script; the body moves
    // into a function. Kept as a comment so line numbers stay put.
    if (esm.startsWith('#!'))
        edits.push({ start: 0, end: 2, text: '//' });
    for (const node of program.body) {
        switch (node.type) {
            case 'ImportDeclaration': {
                edits.push({ start: node.start, end: node.end, text: '' });
                if (node.specifiers.length === 0) {
                    requires.push(`require(${JSON.stringify(String(node.source.value))});`);
                    break;
                }
                const mod = temp();
                const bindings = [`const ${mod} = ${imported(node.source)};`];
                for (const specifier of node.specifiers) {
                    const local = specifier.local.name;
                    if (specifier.type === 'ImportNamespaceSpecifier')
                        bindings.push(`const ${local} = ${mod};`);
                    else if (specifier.type === 'ImportDefaultSpecifier')
                        bindings.push(`const ${local} = ${mod}.default;`);
                    else
                        bindings.push(`const ${local} = ${mod}${key(nameOf(specifier.imported))};`);
                }
                requires.push(bindings.join(' '));
                break;
            }
            case 'ExportNamedDeclaration': {
                if (node.declaration) {
                    edits.push({ start: node.start, end: node.declaration.start, text: '' });
                    const names = declaredNames(node.declaration);
                    edits.push({
                        start: node.end, end: node.end,
                        text: '\n' + names.map((name) => `module.exports${key(name)} = ${name};`).join(' '),
                    });
                }
                else {
                    exportsDefault ||= node.specifiers.some((s) => nameOf(s.exported) === 'default');
                    if (node.source) {
                        const mod = temp();
                        const assigns = node.specifiers.map((s) => `module.exports${key(nameOf(s.exported))} = ${mod}${key(nameOf(s.local))};`);
                        edits.push({ start: node.start, end: node.end, text: `{ const ${mod} = ${imported(node.source)}; ${assigns.join(' ')} }` });
                    }
                    else {
                        const assigns = node.specifiers.map((s) => `module.exports${key(nameOf(s.exported))} = ${nameOf(s.local)};`);
                        edits.push({ start: node.start, end: node.end, text: assigns.join(' ') });
                    }
                }
                break;
            }
            case 'ExportDefaultDeclaration': {
                exportsDefault = true;
                const declaration = node.declaration;
                if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
                    edits.push({ start: node.start, end: declaration.start, text: '' });
                    edits.push({ start: node.end, end: node.end, text: `\nmodule.exports.default = ${declaration.id.name};` });
                }
                else {
                    edits.push({
                        start: node.start, end: node.end,
                        text: `module.exports.default = (${esm.slice(declaration.start, declaration.end)});`,
                    });
                }
                break;
            }
            case 'ExportAllDeclaration': {
                const mod = temp();
                if (node.exported)
                    exportsDefault ||= nameOf(node.exported) === 'default';
                const text = node.exported
                    ? `module.exports${key(nameOf(node.exported))} = ${imported(node.source)};`
                    : `{ const ${mod} = ${imported(node.source)}; for (const k in ${mod}) if (k !== "default") module.exports[k] = ${mod}[k]; }`;
                edits.push({ start: node.start, end: node.end, text });
                break;
            }
            default:
                break;
        }
    }
    const parts = [];
    let at = 0;
    for (const { start, end, text } of edits.sort((a, b) => a.start - b.start)) {
        parts.push(esm.slice(at, start), text);
        at = end;
    }
    parts.push(esm.slice(at));
    // Marked before any require runs, so a module in an import cycle already
    // sees this one as an ES module.
    const prologue = [markEsmNamespaceSource('module.exports', exportsDefault), namespaceHelperSource(namespace)];
    return `${[...prologue, ...requires].join('\n')}\nreturn (async () => {\n${parts.join('')}\n})();\n`;
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
