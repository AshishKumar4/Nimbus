import { parse } from 'acorn';
export function parseJavaScriptModule(source) {
    return parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowHashBang: true,
    });
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
