/**
 * Lower an ES module with top-level await to a CommonJS function body.
 *
 * The transform refuses `format: 'cjs'` for top-level await, so it first
 * emits the module as ESM (TypeScript, JSX and defines already applied) and
 * this turns that output into the body the CommonJS cell runs. As in Node,
 * every module the source requests is evaluated before its body: each import
 * and re-export becomes a require above an async IIFE holding the rest, in
 * source order. Each export is a live getter on `module.exports`, installed
 * before the body runs: a binding the body assigns after an `await` (`export
 * let db; db = await connect()`) reads as assigned, wherever the transform
 * printed its export. A default expression is assigned where it is evaluated.
 * Acorn's module parse gives
 * the declarations; esbuild prints an import or export clause across several
 * lines when it is long (serve 14's `import {\n resolve as resolvePath, ... }
 * from "node:path"`), so no line or text pattern can stand in for it.
 *
 * Runs in the transform facet (installed by oxc-facet/preamble.ts) and, for
 * in-process transforms, in esbuild-service.ts.
 */
import { Parser } from 'acorn';
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
    const sourceOf = (node) => JSON.stringify(String(node.value));
    // The cell's top level holds only generated names (its records and these):
    // the module's own bindings, its imports' included, are inside the IIFE, so
    // nothing it declares (`import Object from "dep"`) reaches what these read.
    const exportsRef = temp();
    const exportGetter = temp();
    const defineProperty = temp();
    const live = (exported, value) => `${exportGetter}(${JSON.stringify(exported)}, () => ${value});`;
    const requires = [];
    // Inside the IIFE, before the body: the imports' bindings, read off their
    // records, then a getter per export name, installed in name order (a module
    // namespace's), whichever order the transform printed.
    const imported = [];
    const getters = [];
    const edits = [];
    let exportsAnything = false;
    // A hashbang is only valid as the first line of a script; the body moves
    // into a function. Kept as a comment so line numbers stay put.
    if (esm.startsWith('#!'))
        edits.push({ start: 0, end: 2, text: '//' });
    for (const node of program.body) {
        switch (node.type) {
            case 'ImportDeclaration': {
                edits.push({ start: node.start, end: node.end, text: '' });
                if (node.specifiers.length === 0) {
                    requires.push(`require(${sourceOf(node.source)});`);
                    break;
                }
                const mod = temp();
                requires.push(`const ${mod} = require(${sourceOf(node.source)});`);
                for (const specifier of node.specifiers) {
                    const local = specifier.local.name;
                    if (specifier.type === 'ImportNamespaceSpecifier')
                        imported.push(`const ${local} = ${mod};`);
                    else if (specifier.type === 'ImportDefaultSpecifier') {
                        imported.push(`const ${local} = ${mod} && ${mod}.__esModule ? ${mod}.default : ${mod};`);
                    }
                    else
                        imported.push(`const ${local} = ${mod}${key(nameOf(specifier.imported))};`);
                }
                break;
            }
            case 'ExportNamedDeclaration': {
                exportsAnything = true;
                if (node.declaration) {
                    edits.push({ start: node.start, end: node.declaration.start, text: '' });
                    for (const name of declaredNames(node.declaration))
                        getters.push([name, name]);
                }
                else if (node.source) {
                    const mod = temp();
                    edits.push({ start: node.start, end: node.end, text: '' });
                    requires.push(`const ${mod} = require(${sourceOf(node.source)});`);
                    for (const s of node.specifiers)
                        getters.push([nameOf(s.exported), `${mod}${key(nameOf(s.local))}`]);
                }
                else {
                    edits.push({ start: node.start, end: node.end, text: '' });
                    for (const s of node.specifiers)
                        getters.push([nameOf(s.exported), nameOf(s.local)]);
                }
                break;
            }
            case 'ExportDefaultDeclaration': {
                exportsAnything = true;
                const declaration = node.declaration;
                if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
                    edits.push({ start: node.start, end: declaration.start, text: '' });
                    getters.push(['default', declaration.id.name]);
                }
                else {
                    edits.push({
                        start: node.start, end: node.end,
                        text: `${exportsRef}.default = (${esm.slice(declaration.start, declaration.end)});`,
                    });
                }
                break;
            }
            case 'ExportAllDeclaration': {
                exportsAnything = true;
                const mod = temp();
                edits.push({ start: node.start, end: node.end, text: '' });
                requires.push(`const ${mod} = require(${sourceOf(node.source)});`);
                // `*` goes first; a name exported explicitly, installed after it, wins.
                if (node.exported)
                    getters.push([nameOf(node.exported), mod]);
                else
                    requires.push(`for (const k in ${mod}) if (k !== "default" && k !== "__esModule") ${exportGetter}(k, () => ${mod}[k]);`);
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
    const header = exportsAnything
        ? [
            `const ${exportsRef} = module.exports; ${exportsRef}.__esModule = true; const ${defineProperty} = Object.defineProperty;`,
            `const ${exportGetter} = (name, get) => ${defineProperty}(${exportsRef}, name, { enumerable: true, configurable: true, get });`,
        ]
        : [];
    const installed = getters
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([exported, value]) => live(exported, value));
    return `${[...header, ...requires].join('\n')}\nreturn (async () => { ${[...imported, ...installed].join(' ')}\n${parts.join('')}\n})();\n`;
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
