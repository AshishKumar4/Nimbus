import { forEachNode, parseJavaScriptProgram } from './javascript-ast.js';
const CODE_BY_NAME = new Set([
    'createRequire', 'getBuiltinModule', 'mainModule', 'eval', 'Function', '_load', 'bindings', 'vm', 'importScripts', '__nimbusDynamicImport',
    'arguments',
]);
/** What a specifier the walk's patterns read may hold: no quote of any kind, no escape, no line break, no `$`. */
const PLAIN = /^[^'"`\\\n$]+$/;
/** Whether `node` is a specifier the walk reads as it is written. */
function plain(node) {
    if (!node)
        return false;
    if (node.type === 'Literal')
        return typeof node.value === 'string' && PLAIN.test(node.value) && !(node.raw ?? '\\').includes('\\');
    if (node.type === 'TemplateLiteral') {
        const [only] = node.quasis;
        return node.expressions.length === 0 && node.quasis.length === 1 && only !== undefined && PLAIN.test(only.value.raw);
    }
    return false;
}
/** A word without which a module makes no load at all, nor code from a string: one is needed before a parse can tell anything. */
const LOAD_WORDS = /require|import|export|module|Module|arguments|getBuiltinModule|eval|Function|_load|bindings|vm|importScripts|__nimbusDynamicImport|\\u/;
/** Whether `source` can load code the walk does not stage (see the header). */
export function hasOpaqueLoads(source) {
    // Most of a closure (a builtins-only program, a leaf module) names none of them: no parse needed.
    if (!LOAD_WORDS.test(source))
        return false;
    const program = parseJavaScriptProgram(source);
    if (program === null)
        return true;
    // The `require` identifiers that are the callee of a load the walk follows, and the `module`s of `module.exports`.
    const followed = new Set();
    let opaque = false;
    forEachNode(program, (node) => {
        if (opaque)
            return;
        if (node.type === 'CallExpression' && node.arguments.length === 1 && plain(node.arguments[0])) {
            const callee = node.callee;
            if (callee.type === 'Identifier' && callee.name === 'require')
                followed.add(callee);
            if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'require'
                && callee.property.type === 'Identifier' && callee.property.name === 'resolve')
                followed.add(callee.object);
        }
        if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'module'
            && node.property.type === 'Identifier' && node.property.name === 'exports')
            followed.add(node.object);
        if (node.type === 'ImportExpression' && ((node.options ?? null) !== null || !plain(node.source)))
            opaque = true;
        if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') && !plain(node.source))
            opaque = true;
        if (node.type === 'ExportNamedDeclaration' && node.source && !plain(node.source))
            opaque = true;
    });
    if (opaque)
        return true;
    forEachNode(program, (node) => {
        if (opaque || node.type !== 'Identifier')
            return;
        if (CODE_BY_NAME.has(node.name) || ((node.name === 'require' || node.name === 'module') && !followed.has(node)))
            opaque = true;
    });
    return opaque;
}
