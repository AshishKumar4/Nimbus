import { parse } from 'acorn';
import { ancestor } from 'acorn-walk';
export function parseJavaScriptModule(source) {
    return parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowHashBang: true,
        allowAwaitOutsideFunction: true,
    });
}
const FUNCTION_NODE_TYPES = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
]);
/**
 * True iff the module contains a genuine top-level `await` — an
 * `AwaitExpression` (or `for await` loop) with no enclosing function in
 * its ancestor chain. AST-based so default-value parameter braces
 * (`async function f(opts = {})`), destructured params, and
 * arrow-expression bodies can't confuse a brace-depth heuristic.
 *
 * Returns false when parsing fails — callers treat that as "not TLA"
 * and the plain single-pass transform handles it.
 */
export function hasTopLevelAwait(source) {
    if (!source || source.indexOf('await') === -1)
        return false;
    let ast;
    try {
        ast = parseJavaScriptModule(source);
    }
    catch {
        return false;
    }
    let found = false;
    const isTopLevel = (ancestors) => {
        // ancestors includes the node itself at the tail; scan the rest for
        // any enclosing function scope.
        for (let i = 0; i < ancestors.length - 1; i++) {
            if (FUNCTION_NODE_TYPES.has(ancestors[i].type))
                return false;
        }
        return true;
    };
    ancestor(ast, {
        AwaitExpression(_node, _state, ancestors) {
            if (!found && isTopLevel(ancestors))
                found = true;
        },
        ForOfStatement(node, _state, ancestors) {
            if (!found && node.await && isTopLevel(ancestors))
                found = true;
        },
    });
    return found;
}
export function hasTopLevelModuleSyntax(source) {
    let ast;
    try {
        ast = parseJavaScriptModule(source);
    }
    catch {
        return false;
    }
    return nodeList(ast, 'body').some((node) => node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportDefaultDeclaration' ||
        node.type === 'ExportAllDeclaration');
}
export function nodeList(node, key) {
    const value = node[key];
    if (!Array.isArray(value))
        return [];
    return value.filter(isAstNode);
}
export function nodeProp(node, key) {
    if (!node)
        return undefined;
    const value = node[key];
    return isAstNode(value) ? value : undefined;
}
export function nodeName(node) {
    if (node?.type !== 'Identifier' && node?.type !== 'Literal')
        return undefined;
    if (node.type === 'Identifier')
        return stringField(node, 'name');
    return literalStringValue(node);
}
export function stringField(node, key) {
    const value = node[key];
    return typeof value === 'string' ? value : undefined;
}
export function booleanField(node, key) {
    const value = node[key];
    return typeof value === 'boolean' ? value : false;
}
export function literalStringValue(node) {
    return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}
export function literalBooleanValue(node) {
    return node?.type === 'Literal' && typeof node.value === 'boolean' ? node.value : undefined;
}
export function isAstNode(value) {
    return !!value && typeof value === 'object' && typeof value.type === 'string';
}
