import { simple } from 'acorn-walk';
import MagicString from 'magic-string';
import { literalStringValue, nodeList, nodeProp, parseJavaScriptModule, stringField, } from './javascript-ast.js';
export function rewriteJavaScriptModuleSource(source, options) {
    const ast = parseJavaScriptModule(source);
    const edits = new MagicString(source);
    simple(ast, {
        ImportDeclaration(node) {
            rewriteStaticSpecifier(node, options, edits);
        },
        ExportNamedDeclaration(node) {
            rewriteStaticSpecifier(node, options, edits);
        },
        ExportAllDeclaration(node) {
            rewriteStaticSpecifier(node, options, edits);
        },
        ImportExpression(node) {
            rewriteDynamicImport(node, options, edits);
        },
        CallExpression(node) {
            rewriteCreateRequireCall(node, options, edits);
        },
    });
    return edits.toString();
}
function rewriteStaticSpecifier(node, options, edits) {
    const sourceNode = nodeProp(node, 'source');
    const specifier = literalStringValue(sourceNode);
    if (!specifier)
        return;
    const replacement = options.staticSpecifier(specifier, {
        nodeType: node.type,
        isSideEffectImport: node.type === 'ImportDeclaration' && nodeList(node, 'specifiers').length === 0,
    });
    if (replacement)
        overwriteNode(edits, sourceNode, JSON.stringify(replacement));
}
function rewriteDynamicImport(node, options, edits) {
    if (!options.dynamicImport)
        return;
    const sourceNode = nodeProp(node, 'source');
    const specifier = literalStringValue(sourceNode);
    if (!specifier)
        return;
    const replacement = options.dynamicImport(specifier);
    if (replacement)
        overwriteNode(edits, node, replacement);
}
function rewriteCreateRequireCall(node, options, edits) {
    if (!options.createRequireCallee || node.type !== 'CallExpression')
        return;
    const callee = nodeProp(node, 'callee');
    if (callee?.type !== 'Identifier' || stringField(callee, 'name') !== 'createRequire')
        return;
    overwriteNode(edits, callee, options.createRequireCallee);
}
function overwriteNode(edits, node, text) {
    if (typeof node?.start !== 'number' || typeof node.end !== 'number')
        return;
    edits.overwrite(node.start, node.end, text);
}
