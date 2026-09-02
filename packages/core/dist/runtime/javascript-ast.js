import { parse, tokenizer, tokTypes } from 'acorn';
export function parseJavaScriptModule(source) {
    return parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowHashBang: true,
    });
}
export function hasTopLevelModuleSyntax(source) {
    try {
        const tokens = tokenizer(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowHashBang: true,
        });
        let braceDepth = 0;
        let parenDepth = 0;
        let bracketDepth = 0;
        let previous;
        const updateDepth = (type) => {
            if (type === tokTypes.braceL || type === tokTypes.dollarBraceL)
                braceDepth++;
            else if (type === tokTypes.braceR)
                braceDepth = Math.max(0, braceDepth - 1);
            else if (type === tokTypes.parenL)
                parenDepth++;
            else if (type === tokTypes.parenR)
                parenDepth = Math.max(0, parenDepth - 1);
            else if (type === tokTypes.bracketL)
                bracketDepth++;
            else if (type === tokTypes.bracketR)
                bracketDepth = Math.max(0, bracketDepth - 1);
        };
        while (true) {
            const token = tokens.getToken();
            const type = token.type;
            if (type === tokTypes.eof)
                return false;
            const topLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
            if (topLevel && previous !== tokTypes.dot) {
                if (type === tokTypes._export)
                    return true;
                if (type === tokTypes._import) {
                    const next = tokens.getToken();
                    if (next.type !== tokTypes.parenL && next.type !== tokTypes.dot)
                        return true;
                    updateDepth(next.type);
                    previous = next.type;
                    continue;
                }
            }
            updateDepth(type);
            previous = type;
        }
    }
    catch {
        return false;
    }
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
