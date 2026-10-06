/**
 * javascript-scope.ts — which scope a name in a parsed program binds to.
 *
 * Reads ESTree as acorn and rolldown's parser give it, structurally (any
 * object with a string `type` and numeric `start` and `end` is a node), so
 * TypeScript's binding forms count where they bind at run time. The scopes
 * are the language's: a program's and a static block's, a function's
 * parameters and its body's `var`s, a block's, a switch's, a `for` head's
 * `let` and `const`, a catch clause's, and a class's name inside its body.
 *
 * Self-contained: rolldown-compat.ts (the build facet's runtime) and
 * async-module-lowering.ts (the transform facet's) both bundle it.
 */
export function isNode(value) {
    return typeof value === 'object' && value !== null
        && 'type' in value && typeof value.type === 'string'
        && 'start' in value && typeof value.start === 'number'
        && 'end' in value && typeof value.end === 'number';
}
/** `node[key]` when it is a node. */
export function child(node, key) {
    const value = node?.[key];
    return isNode(value) ? value : null;
}
/** The nodes of the list `node[key]`. */
export function list(node, key) {
    const value = node?.[key];
    return Array.isArray(value) ? value.filter(isNode) : [];
}
/** `node[key]` when it is a string. */
export function stringOf(node, key) {
    const value = node?.[key];
    return typeof value === 'string' ? value : null;
}
/** The names a binding binds: an identifier, or what the parts of a pattern bind. */
export function* patternNames(node) {
    switch (node?.type) {
        case 'Identifier': {
            const name = stringOf(node, 'name');
            if (name !== null)
                yield name;
            return;
        }
        case 'ObjectPattern':
            for (const property of list(node, 'properties'))
                yield* patternNames(child(property, property.type === 'RestElement' ? 'argument' : 'value'));
            return;
        case 'ArrayPattern':
            for (const element of list(node, 'elements'))
                yield* patternNames(element);
            return;
        case 'RestElement':
            yield* patternNames(child(node, 'argument'));
            return;
        case 'AssignmentPattern':
            yield* patternNames(child(node, 'left'));
            return;
        case 'TSParameterProperty':
            yield* patternNames(child(node, 'parameter'));
            return;
        // `namespace A.B {}` binds A.
        case 'TSQualifiedName':
            yield* patternNames(child(node, 'left'));
            return;
    }
}
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** The names a list of statements binds lexically: let, const, class, function and import. */
function* lexicalNames(statements) {
    for (const statement of statements) {
        const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? child(statement, 'declaration') : statement;
        if (node?.type === 'VariableDeclaration' && node.kind !== 'var') {
            for (const declarator of list(node, 'declarations'))
                yield* patternNames(child(declarator, 'id'));
        }
        if (node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration')
            yield* patternNames(child(node, 'id'));
        if (node?.type === 'ImportDeclaration')
            for (const specifier of list(node, 'specifiers'))
                yield* patternNames(child(specifier, 'local'));
    }
}
/**
 * The names `var` binds in `value` for the function (or program, or static
 * block) it is in, not entering nested ones; in sloppy code, a function
 * declared in a block is one of them too (Annex B).
 */
function* varNames(value, sloppy, top = true) {
    if (Array.isArray(value)) {
        for (const item of value)
            yield* varNames(item, sloppy, top);
        return;
    }
    if (!isNode(value))
        return;
    if (value.type === 'FunctionDeclaration' && sloppy && !top)
        yield* patternNames(child(value, 'id'));
    if (FUNCTIONS.has(value.type) || value.type === 'StaticBlock')
        return;
    if (value.type === 'VariableDeclaration' && value.kind === 'var') {
        for (const declarator of list(value, 'declarations'))
            yield* patternNames(child(declarator, 'id'));
    }
    for (const [key, item] of Object.entries(value))
        if (key !== 'parent')
            yield* varNames(item, sloppy, false);
}
/**
 * The scope `node`'s children are in, given the one it is in. A function's
 * parameters are in a scope of their own, its body's `var`s in its body's
 * (a parameter's default value does not see them).
 */
function scopeOf(node, scope, sloppy, functionBody) {
    const within = (names) => ({ names: new Set(names), parent: scope });
    switch (node.type) {
        case 'Program':
        case 'StaticBlock':
            return within([...varNames(list(node, 'body'), sloppy), ...lexicalNames(list(node, 'body'))]);
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            return within([
                ...(node.type === 'FunctionExpression' ? patternNames(child(node, 'id')) : []),
                ...list(node, 'params').flatMap((parameter) => [...patternNames(parameter)]),
            ]);
        case 'BlockStatement':
            return within([...(functionBody ? varNames(list(node, 'body'), sloppy) : []), ...lexicalNames(list(node, 'body'))]);
        case 'SwitchStatement':
            return within(lexicalNames(list(node, 'cases').flatMap((c) => list(c, 'consequent'))));
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement': {
            const head = child(node, node.type === 'ForStatement' ? 'init' : 'left');
            return within(head?.type === 'VariableDeclaration' && head.kind !== 'var'
                ? list(head, 'declarations').flatMap((declarator) => [...patternNames(child(declarator, 'id'))])
                : []);
        }
        case 'CatchClause':
            return within(patternNames(child(node, 'param')));
        // A class's name is its body's too (an expression's, only its body's).
        case 'ClassDeclaration':
        case 'ClassExpression':
            return within(patternNames(child(node, 'id')));
        default:
            return scope;
    }
}
/**
 * Every node under `value`, each before its children, with the scope it is
 * in, the node it is under and the key it is under that node by (null and
 * '' for `value` itself). A program's own scope is the one whose parent is
 * `scope`.
 */
export function* scoped(value, scope, sloppy, functionBody = false, parent = null, key = '') {
    if (Array.isArray(value)) {
        for (const item of value)
            yield* scoped(item, scope, sloppy, false, parent, key);
        return;
    }
    if (!isNode(value))
        return;
    yield [value, scope, parent, key];
    const inner = scopeOf(value, scope, sloppy, functionBody);
    const isFunction = FUNCTIONS.has(value.type);
    for (const [field, item] of Object.entries(value)) {
        if (field !== 'parent')
            yield* scoped(item, inner, sloppy, isFunction && field === 'body', value, field);
    }
}
/** The innermost scope from `scope` out that binds `name`, or null where none does. */
export function bindingScope(scope, name) {
    for (let at = scope; at; at = at.parent)
        if (at.names.has(name))
            return at;
    return null;
}
/**
 * Whether an identifier under `parent` by `key` reads or writes a binding,
 * rather than naming a property, a key or a label, `import.meta`'s parts, or
 * an import or export specifier's names (the declaration's, or the other
 * module's).
 */
export function namesBinding(parent, key) {
    switch (parent.type) {
        case 'MemberExpression':
            return key !== 'property' || parent.computed === true;
        case 'Property':
        case 'MethodDefinition':
        case 'PropertyDefinition':
            return key !== 'key' || parent.computed === true;
        case 'ImportAttribute':
            return key !== 'key';
        case 'LabeledStatement':
        case 'BreakStatement':
        case 'ContinueStatement':
        case 'MetaProperty':
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
        case 'ExportSpecifier':
        case 'ExportAllDeclaration':
            return false;
        default:
            return true;
    }
}
/** Whether a program's code is sloppy: a script without "use strict". */
export function isSloppy(program) {
    if (program.sourceType === 'module')
        return false;
    return !list(program, 'body').some((statement) => statement.type === 'ExpressionStatement' && statement.directive === 'use strict');
}
