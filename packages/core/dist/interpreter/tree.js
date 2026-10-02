import { BigInt, Error, append, arrayIsArray, charCodeAt, newSafeList, objectAssign, objectFreeze, objectHasOwn, reflectGet, reflectSetPrototypeOf, } from './intrinsics.js';
/** Where the copy being made records its functions, for reparse.ts to find one by its offsets. */
let functions = null;
/** The interpreter's copy of a program acorn parsed. Each function in it is appended to `found`, if given. */
export function ownProgram(program, found = null) {
    // Reading a field can run a program's accessor, which can compile code of its own.
    const outer = functions;
    functions = found;
    try {
        return only(program, 'Program', copyProgram);
    }
    finally {
        functions = outer;
    }
}
/** The interpreter's copy of a function expression acorn parsed (a Function constructor's). */
export function ownFunctionExpression(node) {
    const outer = functions;
    functions = null;
    try {
        return only(node, 'FunctionExpression', copyFunctionExpression);
    }
    finally {
        functions = outer;
    }
}
function refuse(what) {
    throw new Error(`interpreter: the parser produced ${what}`);
}
function describe(type) {
    return typeof type === 'string' ? `a ${type}` : `a node whose type is a ${typeof type}`;
}
// ── Fields ──
function sourceOf(value) {
    if (typeof value !== 'object' || value === null || arrayIsArray(value))
        return refuse('a node that is not an object');
    return value;
}
function num(source, key) {
    const value = reflectGet(source, key);
    return typeof value === 'number' ? value : refuse(`a ${key} that is not a number`);
}
function str(source, key) {
    const value = reflectGet(source, key);
    return typeof value === 'string' ? value : refuse(`a ${key} that is not a string`);
}
function bool(source, key) {
    const value = reflectGet(source, key);
    return typeof value === 'boolean' ? value : refuse(`a ${key} that is not a boolean`);
}
function optionalString(source, key) {
    const value = reflectGet(source, key);
    return value === undefined || typeof value === 'string' ? value : refuse(`a ${key} that is not a string`);
}
/** Whether `value` is one of the members `table` lists (each member of T, and only those). */
function isMember(table, value) {
    return objectHasOwn(table, value);
}
function member(table, value, what) {
    if (typeof value === 'string' && isMember(table, value))
        return value;
    return refuse(`an unknown ${what}`);
}
const SOURCE_TYPES = { script: true, module: true };
const DECLARATION_KINDS = { var: true, let: true, const: true, using: true, 'await using': true };
const PROPERTY_KINDS = { init: true, get: true, set: true };
const METHOD_KINDS = { constructor: true, method: true, get: true, set: true };
const UNARY = { '-': true, '+': true, '!': true, '~': true, typeof: true, void: true, delete: true };
const UPDATE = { '++': true, '--': true };
const BINARY = {
    '==': true, '!=': true, '===': true, '!==': true, '<': true, '<=': true, '>': true, '>=': true, '<<': true, '>>': true, '>>>': true,
    '+': true, '-': true, '*': true, '/': true, '%': true, '|': true, '^': true, '&': true, in: true, instanceof: true, '**': true,
};
const ASSIGNMENT = {
    '=': true, '+=': true, '-=': true, '*=': true, '/=': true, '%=': true, '<<=': true, '>>=': true, '>>>=': true, '|=': true, '^=': true,
    '&=': true, '**=': true, '||=': true, '&&=': true, '??=': true,
};
const LOGICAL = { '||': true, '&&': true, '??': true };
/**
 * `fields` as an object that inherits nothing, frozen: no field of it is
 * looked up through a prototype, or changed. The analysis and the compiler
 * read every node many times, so it is made the way V8 reads fastest: an
 * empty object given a null prototype, then the fields, in the same order
 * for every node of a kind, so that they share one hidden class.
 * Object.create(null) makes a dictionary instead, and a literal whose
 * prototype is changed afterwards gets a hidden class of its own.
 */
function made(fields) {
    const node = {};
    reflectSetPrototypeOf(node, null);
    const owned = objectAssign(node, fields);
    objectFreeze(owned);
    return owned;
}
function list(value, copy) {
    if (!arrayIsArray(value))
        return refuse('a list that is not an array');
    const length = value.length;
    const out = newSafeList();
    for (let i = 0; i < length; i++)
        append(out, copy(reflectGet(value, i)));
    objectFreeze(out);
    return out;
}
function optional(value, copy) {
    return value === null || value === undefined ? null : copy(value);
}
/** A node of one type. */
function only(value, type, copy) {
    const source = sourceOf(value);
    const actual = reflectGet(source, 'type');
    return actual === type ? copy(source) : refuse(`${describe(actual)} where a ${type} goes`);
}
// ── Kinds of node a field holds ──
function expressionOf(s, type) {
    switch (type) {
        case 'Identifier': return copyIdentifier(s);
        case 'MemberExpression': return copyMemberExpression(s);
        case 'CallExpression': return copyCallExpression(s);
        case 'Literal': return copyLiteral(s);
        case 'ThisExpression': return copyThisExpression(s);
        case 'ArrayExpression': return copyArrayExpression(s);
        case 'ObjectExpression': return copyObjectExpression(s);
        case 'FunctionExpression': return copyFunctionExpression(s);
        case 'ArrowFunctionExpression': return copyArrowFunctionExpression(s);
        case 'UnaryExpression': return copyUnaryExpression(s);
        case 'UpdateExpression': return copyUpdateExpression(s);
        case 'BinaryExpression': return copyBinaryExpression(s);
        case 'AssignmentExpression': return copyAssignmentExpression(s);
        case 'LogicalExpression': return copyLogicalExpression(s);
        case 'ConditionalExpression': return copyConditionalExpression(s);
        case 'NewExpression': return copyNewExpression(s);
        case 'SequenceExpression': return copySequenceExpression(s);
        case 'YieldExpression': return copyYieldExpression(s);
        case 'TemplateLiteral': return copyTemplateLiteral(s);
        case 'TaggedTemplateExpression': return copyTaggedTemplateExpression(s);
        case 'ClassExpression': return copyClassExpression(s);
        case 'MetaProperty': return copyMetaProperty(s);
        case 'AwaitExpression': return copyAwaitExpression(s);
        case 'ChainExpression': return copyChainExpression(s);
        case 'ImportExpression': return copyImportExpression(s);
        case 'ParenthesizedExpression': return copyParenthesizedExpression(s);
        default: return null;
    }
}
function declarationOf(s, type) {
    switch (type) {
        case 'VariableDeclaration': return copyVariableDeclaration(s);
        case 'FunctionDeclaration': {
            // Only `export default` declares without a name.
            const node = copyFunctionDeclaration(s);
            return node.id !== null ? node : refuse('a function declaration without a name');
        }
        case 'ClassDeclaration': {
            const node = copyClassDeclaration(s);
            return node.id !== null ? node : refuse('a class declaration without a name');
        }
        default: return null;
    }
}
function statementOf(s, type) {
    switch (type) {
        case 'ExpressionStatement': return copyExpressionStatement(s);
        case 'BlockStatement': return copyBlockStatement(s);
        case 'ReturnStatement': return copyReturnStatement(s);
        case 'IfStatement': return copyIfStatement(s);
        case 'ForStatement': return copyForStatement(s);
        case 'ForInStatement': return copyForInStatement(s);
        case 'ForOfStatement': return copyForOfStatement(s);
        case 'WhileStatement': return copyWhileStatement(s);
        case 'DoWhileStatement': return copyDoWhileStatement(s);
        case 'TryStatement': return copyTryStatement(s);
        case 'ThrowStatement': return copyThrowStatement(s);
        case 'SwitchStatement': return copySwitchStatement(s);
        case 'BreakStatement': return copyBreakStatement(s);
        case 'ContinueStatement': return copyContinueStatement(s);
        case 'LabeledStatement': return copyLabeledStatement(s);
        case 'EmptyStatement': return copyEmptyStatement(s);
        case 'DebuggerStatement': return copyDebuggerStatement(s);
        case 'WithStatement': return copyWithStatement(s);
        default: return declarationOf(s, type);
    }
}
function moduleDeclarationOf(s, type) {
    switch (type) {
        case 'ImportDeclaration': return copyImportDeclaration(s);
        case 'ExportNamedDeclaration': return copyExportNamedDeclaration(s);
        case 'ExportDefaultDeclaration': return copyExportDefaultDeclaration(s);
        case 'ExportAllDeclaration': return copyExportAllDeclaration(s);
        default: return null;
    }
}
function patternOf(s, type) {
    switch (type) {
        case 'Identifier': return copyIdentifier(s);
        case 'MemberExpression': return copyMemberExpression(s);
        case 'ObjectPattern': return copyObjectPattern(s);
        case 'ArrayPattern': return copyArrayPattern(s);
        case 'RestElement': return copyRestElement(s);
        case 'AssignmentPattern': return copyAssignmentPattern(s);
        default: return null;
    }
}
function expression(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}
function statement(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    return statementOf(s, type) ?? refuse(`${describe(type)} where a statement goes`);
}
function pattern(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    return patternOf(s, type) ?? refuse(`${describe(type)} where a pattern goes`);
}
function statementOrModuleDeclaration(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    return statementOf(s, type) ?? moduleDeclarationOf(s, type) ?? refuse(`${describe(type)} where a statement goes`);
}
function declaration(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    return declarationOf(s, type) ?? refuse(`${describe(type)} where a declaration goes`);
}
function expressionOrSpread(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'SpreadElement')
        return copySpreadElement(s);
    return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}
function expressionOrPrivate(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'PrivateIdentifier')
        return copyPrivateIdentifier(s);
    return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}
function expressionOrSuper(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'Super')
        return copySuper(s);
    return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}
function variablesOrExpression(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'VariableDeclaration')
        return copyVariableDeclaration(s);
    return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}
function variablesOrPattern(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'VariableDeclaration')
        return copyVariableDeclaration(s);
    return patternOf(s, type) ?? refuse(`${describe(type)} where a pattern goes`);
}
function blockOrExpression(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'BlockStatement')
        return copyBlockStatement(s);
    return expressionOf(s, type) ?? refuse(`${describe(type)} where a function body goes`);
}
function propertyOrSpread(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'Property')
        return copyProperty(s);
    if (type === 'SpreadElement')
        return copySpreadElement(s);
    return refuse(`${describe(type)} where a property goes`);
}
function propertyPatternOrRest(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'Property')
        return copyAssignmentProperty(s);
    if (type === 'RestElement')
        return copyRestElement(s);
    return refuse(`${describe(type)} where a property goes`);
}
function classElement(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'MethodDefinition')
        return copyMethodDefinition(s);
    if (type === 'PropertyDefinition')
        return copyPropertyDefinition(s);
    if (type === 'StaticBlock')
        return copyStaticBlock(s);
    return refuse(`${describe(type)} where a class element goes`);
}
function memberOrCall(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'MemberExpression')
        return copyMemberExpression(s);
    if (type === 'CallExpression')
        return copyCallExpression(s);
    return refuse(`${describe(type)} where an optional chain goes`);
}
function identifierOrLiteral(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'Identifier')
        return copyIdentifier(s);
    if (type === 'Literal')
        return copyLiteral(s);
    return refuse(`${describe(type)} where a module export name goes`);
}
function importSpecifier(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'ImportSpecifier')
        return copyImportSpecifier(s);
    if (type === 'ImportDefaultSpecifier')
        return copyImportDefaultSpecifier(s);
    if (type === 'ImportNamespaceSpecifier')
        return copyImportNamespaceSpecifier(s);
    return refuse(`${describe(type)} where an import specifier goes`);
}
function defaultExport(value) {
    const s = sourceOf(value);
    const type = reflectGet(s, 'type');
    if (type === 'FunctionDeclaration')
        return copyFunctionDeclaration(s);
    if (type === 'ClassDeclaration')
        return copyClassDeclaration(s);
    return expressionOf(s, type) ?? refuse(`${describe(type)} where a default export goes`);
}
const identifier = (value) => only(value, 'Identifier', copyIdentifier);
const literal = (value) => only(value, 'Literal', copyLiteral);
const block = (value) => only(value, 'BlockStatement', copyBlockStatement);
// ── Nodes, by type ──
function copyProgram(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const body = list(reflectGet(s, 'body'), statementOrModuleDeclaration);
    const sourceType = member(SOURCE_TYPES, reflectGet(s, 'sourceType'), 'source type');
    return made({ type: 'Program', start, end, body, sourceType });
}
function copyIdentifier(s) {
    const start = num(s, 'start'), end = num(s, 'end'), name = str(s, 'name');
    // The interpreter's own bindings ('%this', '*default*', '#field') have names no identifier can have.
    const first = charCodeAt(name, 0);
    if (first === 0x25 || first === 0x2a || first === 0x23)
        refuse(`the identifier ${name}`);
    return made({ type: 'Identifier', start, end, name });
}
function copyPrivateIdentifier(s) {
    const start = num(s, 'start'), end = num(s, 'end'), name = str(s, 'name');
    return made({ type: 'PrivateIdentifier', start, end, name });
}
function copyLiteral(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const value = reflectGet(s, 'value');
    const raw = optionalString(s, 'raw');
    const regex = optional(reflectGet(s, 'regex'), regexRecord);
    const bigint = optionalString(s, 'bigint');
    if (bigint !== undefined)
        return made({ type: 'Literal', start, end, value: BigInt(bigint), raw, bigint });
    if (regex !== null)
        return made({ type: 'Literal', start, end, value: null, raw, regex });
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return made({ type: 'Literal', start, end, value, raw });
    }
    return refuse('a literal whose value is an object');
}
function regexRecord(value) {
    const s = sourceOf(value);
    const pattern = str(s, 'pattern'), flags = str(s, 'flags');
    return made({ pattern, flags });
}
function copyExpressionStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const node = expression(reflectGet(s, 'expression'));
    const directive = optionalString(s, 'directive');
    return made({ type: 'ExpressionStatement', start, end, expression: node, directive });
}
function copyBlockStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const body = list(reflectGet(s, 'body'), statement);
    return made({ type: 'BlockStatement', start, end, body });
}
function copyEmptyStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    return made({ type: 'EmptyStatement', start, end });
}
function copyDebuggerStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    return made({ type: 'DebuggerStatement', start, end });
}
function copyWithStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const object = expression(reflectGet(s, 'object'));
    const body = statement(reflectGet(s, 'body'));
    return made({ type: 'WithStatement', start, end, object, body });
}
function copyReturnStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const argument = optional(reflectGet(s, 'argument'), expression);
    return made({ type: 'ReturnStatement', start, end, argument });
}
function copyLabeledStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const label = identifier(reflectGet(s, 'label'));
    const body = statement(reflectGet(s, 'body'));
    return made({ type: 'LabeledStatement', start, end, label, body });
}
function copyBreakStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const label = optional(reflectGet(s, 'label'), identifier);
    return made({ type: 'BreakStatement', start, end, label });
}
function copyContinueStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const label = optional(reflectGet(s, 'label'), identifier);
    return made({ type: 'ContinueStatement', start, end, label });
}
function copyIfStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const test = expression(reflectGet(s, 'test'));
    const consequent = statement(reflectGet(s, 'consequent'));
    const alternate = optional(reflectGet(s, 'alternate'), statement);
    return made({ type: 'IfStatement', start, end, test, consequent, alternate });
}
function copySwitchStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const discriminant = expression(reflectGet(s, 'discriminant'));
    const cases = list(reflectGet(s, 'cases'), (item) => only(item, 'SwitchCase', copySwitchCase));
    return made({ type: 'SwitchStatement', start, end, discriminant, cases });
}
function copySwitchCase(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const test = optional(reflectGet(s, 'test'), expression);
    const consequent = list(reflectGet(s, 'consequent'), statement);
    return made({ type: 'SwitchCase', start, end, test, consequent });
}
function copyThrowStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const argument = expression(reflectGet(s, 'argument'));
    return made({ type: 'ThrowStatement', start, end, argument });
}
function copyTryStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const tried = block(reflectGet(s, 'block'));
    const handler = optional(reflectGet(s, 'handler'), (item) => only(item, 'CatchClause', copyCatchClause));
    const finalizer = optional(reflectGet(s, 'finalizer'), block);
    return made({ type: 'TryStatement', start, end, block: tried, handler, finalizer });
}
function copyCatchClause(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const param = optional(reflectGet(s, 'param'), pattern);
    const body = block(reflectGet(s, 'body'));
    return made({ type: 'CatchClause', start, end, param, body });
}
function copyWhileStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const test = expression(reflectGet(s, 'test'));
    const body = statement(reflectGet(s, 'body'));
    return made({ type: 'WhileStatement', start, end, test, body });
}
function copyDoWhileStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const body = statement(reflectGet(s, 'body'));
    const test = expression(reflectGet(s, 'test'));
    return made({ type: 'DoWhileStatement', start, end, body, test });
}
function copyForStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const init = optional(reflectGet(s, 'init'), variablesOrExpression);
    const test = optional(reflectGet(s, 'test'), expression);
    const update = optional(reflectGet(s, 'update'), expression);
    const body = statement(reflectGet(s, 'body'));
    return made({ type: 'ForStatement', start, end, init, test, update, body });
}
function copyForInStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const left = variablesOrPattern(reflectGet(s, 'left'));
    const right = expression(reflectGet(s, 'right'));
    const body = statement(reflectGet(s, 'body'));
    return made({ type: 'ForInStatement', start, end, left, right, body });
}
function copyForOfStatement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const left = variablesOrPattern(reflectGet(s, 'left'));
    const right = expression(reflectGet(s, 'right'));
    const body = statement(reflectGet(s, 'body'));
    const isAwait = bool(s, 'await');
    return made({ type: 'ForOfStatement', start, end, left, right, body, await: isAwait });
}
function copyFunctionDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const id = optional(reflectGet(s, 'id'), identifier);
    const params = list(reflectGet(s, 'params'), pattern);
    const body = block(reflectGet(s, 'body'));
    const generator = bool(s, 'generator'), isExpression = bool(s, 'expression'), isAsync = bool(s, 'async');
    const node = id === null
        ? made({ type: 'FunctionDeclaration', start, end, id, params, body, generator, expression: isExpression, async: isAsync })
        : made({ type: 'FunctionDeclaration', start, end, id, params, body, generator, expression: isExpression, async: isAsync });
    if (functions !== null)
        append(functions, node);
    return node;
}
function copyVariableDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const declarations = list(reflectGet(s, 'declarations'), (item) => only(item, 'VariableDeclarator', copyVariableDeclarator));
    const kind = member(DECLARATION_KINDS, reflectGet(s, 'kind'), 'declaration kind');
    return made({ type: 'VariableDeclaration', start, end, declarations, kind });
}
function copyVariableDeclarator(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const id = pattern(reflectGet(s, 'id'));
    const init = optional(reflectGet(s, 'init'), expression);
    return made({ type: 'VariableDeclarator', start, end, id, init });
}
function copyClassDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const id = optional(reflectGet(s, 'id'), identifier);
    const superClass = optional(reflectGet(s, 'superClass'), expression);
    const body = only(reflectGet(s, 'body'), 'ClassBody', copyClassBody);
    return id === null
        ? made({ type: 'ClassDeclaration', start, end, id, superClass, body })
        : made({ type: 'ClassDeclaration', start, end, id, superClass, body });
}
function copyThisExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    return made({ type: 'ThisExpression', start, end });
}
function copySuper(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    return made({ type: 'Super', start, end });
}
function copyArrayExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const elements = list(reflectGet(s, 'elements'), (item) => optional(item, expressionOrSpread));
    return made({ type: 'ArrayExpression', start, end, elements });
}
function copyObjectExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const properties = list(reflectGet(s, 'properties'), propertyOrSpread);
    return made({ type: 'ObjectExpression', start, end, properties });
}
function copyProperty(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const key = expression(reflectGet(s, 'key'));
    const value = expression(reflectGet(s, 'value'));
    const kind = member(PROPERTY_KINDS, reflectGet(s, 'kind'), 'property kind');
    const method = bool(s, 'method'), shorthand = bool(s, 'shorthand'), computed = bool(s, 'computed');
    return made({ type: 'Property', start, end, key, value, kind, method, shorthand, computed });
}
function copyFunctionExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const id = optional(reflectGet(s, 'id'), identifier);
    const params = list(reflectGet(s, 'params'), pattern);
    const body = block(reflectGet(s, 'body'));
    const generator = bool(s, 'generator'), isExpression = bool(s, 'expression'), isAsync = bool(s, 'async');
    const node = made({
        type: 'FunctionExpression', start, end, id, params, body, generator, expression: isExpression, async: isAsync,
    });
    if (functions !== null)
        append(functions, node);
    return node;
}
function copyArrowFunctionExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const id = optional(reflectGet(s, 'id'), identifier);
    const params = list(reflectGet(s, 'params'), pattern);
    const body = blockOrExpression(reflectGet(s, 'body'));
    const generator = bool(s, 'generator'), isExpression = bool(s, 'expression'), isAsync = bool(s, 'async');
    const node = made({
        type: 'ArrowFunctionExpression', start, end, id, params, body, generator, expression: isExpression, async: isAsync,
    });
    if (functions !== null)
        append(functions, node);
    return node;
}
function copyUnaryExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const operator = member(UNARY, reflectGet(s, 'operator'), 'unary operator');
    const prefix = bool(s, 'prefix');
    const argument = expression(reflectGet(s, 'argument'));
    return made({ type: 'UnaryExpression', start, end, operator, prefix, argument });
}
function copyUpdateExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const operator = member(UPDATE, reflectGet(s, 'operator'), 'update operator');
    const prefix = bool(s, 'prefix');
    const argument = expression(reflectGet(s, 'argument'));
    return made({ type: 'UpdateExpression', start, end, operator, prefix, argument });
}
function copyBinaryExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const operator = member(BINARY, reflectGet(s, 'operator'), 'binary operator');
    const left = expressionOrPrivate(reflectGet(s, 'left'));
    const right = expression(reflectGet(s, 'right'));
    return made({ type: 'BinaryExpression', start, end, operator, left, right });
}
function copyAssignmentExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const operator = member(ASSIGNMENT, reflectGet(s, 'operator'), 'assignment operator');
    const left = pattern(reflectGet(s, 'left'));
    const right = expression(reflectGet(s, 'right'));
    return made({ type: 'AssignmentExpression', start, end, operator, left, right });
}
function copyLogicalExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const operator = member(LOGICAL, reflectGet(s, 'operator'), 'logical operator');
    const left = expression(reflectGet(s, 'left'));
    const right = expression(reflectGet(s, 'right'));
    return made({ type: 'LogicalExpression', start, end, operator, left, right });
}
function copyMemberExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const object = expressionOrSuper(reflectGet(s, 'object'));
    const property = expressionOrPrivate(reflectGet(s, 'property'));
    const computed = bool(s, 'computed'), isOptional = bool(s, 'optional');
    return made({ type: 'MemberExpression', start, end, object, property, computed, optional: isOptional });
}
function copyConditionalExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const test = expression(reflectGet(s, 'test'));
    const consequent = expression(reflectGet(s, 'consequent'));
    const alternate = expression(reflectGet(s, 'alternate'));
    return made({ type: 'ConditionalExpression', start, end, test, consequent, alternate });
}
function copyCallExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const callee = expressionOrSuper(reflectGet(s, 'callee'));
    const args = list(reflectGet(s, 'arguments'), expressionOrSpread);
    const isOptional = bool(s, 'optional');
    return made({ type: 'CallExpression', start, end, callee, arguments: args, optional: isOptional });
}
function copyNewExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const callee = expression(reflectGet(s, 'callee'));
    const args = list(reflectGet(s, 'arguments'), expressionOrSpread);
    return made({ type: 'NewExpression', start, end, callee, arguments: args });
}
function copySequenceExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const expressions = list(reflectGet(s, 'expressions'), expression);
    return made({ type: 'SequenceExpression', start, end, expressions });
}
function copySpreadElement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const argument = expression(reflectGet(s, 'argument'));
    return made({ type: 'SpreadElement', start, end, argument });
}
function copyYieldExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const argument = optional(reflectGet(s, 'argument'), expression);
    const delegate = bool(s, 'delegate');
    return made({ type: 'YieldExpression', start, end, argument, delegate });
}
function copyTemplateLiteral(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const quasis = list(reflectGet(s, 'quasis'), (item) => only(item, 'TemplateElement', copyTemplateElement));
    const expressions = list(reflectGet(s, 'expressions'), expression);
    return made({ type: 'TemplateLiteral', start, end, quasis, expressions });
}
function copyTemplateElement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const tail = bool(s, 'tail');
    const text = sourceOf(reflectGet(s, 'value'));
    const cooked = reflectGet(text, 'cooked');
    const raw = str(text, 'raw');
    // An invalid escape in a tagged template: no cooked string.
    if (cooked !== null && cooked !== undefined && typeof cooked !== 'string')
        refuse('a cooked template string that is not a string');
    return made({ type: 'TemplateElement', start, end, tail, value: made({ cooked, raw }) });
}
function copyTaggedTemplateExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const tag = expression(reflectGet(s, 'tag'));
    const quasi = only(reflectGet(s, 'quasi'), 'TemplateLiteral', copyTemplateLiteral);
    return made({ type: 'TaggedTemplateExpression', start, end, tag, quasi });
}
function copyObjectPattern(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const properties = list(reflectGet(s, 'properties'), propertyPatternOrRest);
    return made({ type: 'ObjectPattern', start, end, properties });
}
function copyAssignmentProperty(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const key = expression(reflectGet(s, 'key'));
    const value = pattern(reflectGet(s, 'value'));
    const kind = reflectGet(s, 'kind');
    const method = reflectGet(s, 'method');
    const shorthand = bool(s, 'shorthand'), computed = bool(s, 'computed');
    if (kind !== 'init' || method !== false)
        return refuse('a pattern property that is a method or accessor');
    return made({ type: 'Property', start, end, key, value, kind, method, shorthand, computed });
}
function copyArrayPattern(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const elements = list(reflectGet(s, 'elements'), (item) => optional(item, pattern));
    return made({ type: 'ArrayPattern', start, end, elements });
}
function copyRestElement(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const argument = pattern(reflectGet(s, 'argument'));
    return made({ type: 'RestElement', start, end, argument });
}
function copyAssignmentPattern(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const left = pattern(reflectGet(s, 'left'));
    const right = expression(reflectGet(s, 'right'));
    return made({ type: 'AssignmentPattern', start, end, left, right });
}
function copyClassExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const id = optional(reflectGet(s, 'id'), identifier);
    const superClass = optional(reflectGet(s, 'superClass'), expression);
    const body = only(reflectGet(s, 'body'), 'ClassBody', copyClassBody);
    return made({ type: 'ClassExpression', start, end, id, superClass, body });
}
function copyClassBody(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const body = list(reflectGet(s, 'body'), classElement);
    return made({ type: 'ClassBody', start, end, body });
}
function copyMethodDefinition(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const key = expressionOrPrivate(reflectGet(s, 'key'));
    const value = only(reflectGet(s, 'value'), 'FunctionExpression', copyFunctionExpression);
    const kind = member(METHOD_KINDS, reflectGet(s, 'kind'), 'method kind');
    const computed = bool(s, 'computed'), isStatic = bool(s, 'static');
    return made({ type: 'MethodDefinition', start, end, key, value, kind, computed, static: isStatic });
}
function copyPropertyDefinition(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const key = expressionOrPrivate(reflectGet(s, 'key'));
    const value = optional(reflectGet(s, 'value'), expression);
    const computed = bool(s, 'computed'), isStatic = bool(s, 'static');
    return made({ type: 'PropertyDefinition', start, end, key, value, computed, static: isStatic });
}
function copyStaticBlock(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const body = list(reflectGet(s, 'body'), statement);
    return made({ type: 'StaticBlock', start, end, body });
}
function copyMetaProperty(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const meta = identifier(reflectGet(s, 'meta'));
    const property = identifier(reflectGet(s, 'property'));
    return made({ type: 'MetaProperty', start, end, meta, property });
}
function copyAwaitExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const argument = expression(reflectGet(s, 'argument'));
    return made({ type: 'AwaitExpression', start, end, argument });
}
function copyChainExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const node = memberOrCall(reflectGet(s, 'expression'));
    return made({ type: 'ChainExpression', start, end, expression: node });
}
function copyImportExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const source = expression(reflectGet(s, 'source'));
    const options = optional(reflectGet(s, 'options'), expression);
    return made({ type: 'ImportExpression', start, end, source, options });
}
function copyParenthesizedExpression(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const node = expression(reflectGet(s, 'expression'));
    return made({ type: 'ParenthesizedExpression', start, end, expression: node });
}
function copyImportDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const specifiers = list(reflectGet(s, 'specifiers'), importSpecifier);
    const source = literal(reflectGet(s, 'source'));
    const attributes = list(reflectGet(s, 'attributes'), importAttribute);
    return made({ type: 'ImportDeclaration', start, end, specifiers, source, attributes });
}
function copyImportSpecifier(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const importedSource = reflectGet(s, 'imported');
    const imported = identifierOrLiteral(importedSource);
    const localSource = reflectGet(s, 'local');
    // acorn gives `import { x }` one node for both names: it is copied, and read, once.
    const local = localSource !== importedSource ? identifier(localSource)
        : imported.type === 'Identifier' ? imported : refuse('a string literal as an imported binding');
    return made({ type: 'ImportSpecifier', start, end, imported, local });
}
function copyImportDefaultSpecifier(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const local = identifier(reflectGet(s, 'local'));
    return made({ type: 'ImportDefaultSpecifier', start, end, local });
}
function copyImportNamespaceSpecifier(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const local = identifier(reflectGet(s, 'local'));
    return made({ type: 'ImportNamespaceSpecifier', start, end, local });
}
function importAttribute(value) {
    return only(value, 'ImportAttribute', copyImportAttribute);
}
function copyImportAttribute(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const key = identifierOrLiteral(reflectGet(s, 'key'));
    const value = literal(reflectGet(s, 'value'));
    return made({ type: 'ImportAttribute', start, end, key, value });
}
function copyExportNamedDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const node = optional(reflectGet(s, 'declaration'), declaration);
    const specifiers = list(reflectGet(s, 'specifiers'), (item) => only(item, 'ExportSpecifier', copyExportSpecifier));
    const source = optional(reflectGet(s, 'source'), literal);
    const attributes = list(reflectGet(s, 'attributes'), importAttribute);
    return made({ type: 'ExportNamedDeclaration', start, end, declaration: node, specifiers, source, attributes });
}
function copyExportSpecifier(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const localSource = reflectGet(s, 'local');
    const local = identifierOrLiteral(localSource);
    const exportedSource = reflectGet(s, 'exported');
    // acorn gives `export { x }` one node for both names: it is copied, and read, once.
    const exported = exportedSource === localSource ? local : identifierOrLiteral(exportedSource);
    return made({ type: 'ExportSpecifier', start, end, local, exported });
}
function copyExportDefaultDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const node = defaultExport(reflectGet(s, 'declaration'));
    return made({ type: 'ExportDefaultDeclaration', start, end, declaration: node });
}
function copyExportAllDeclaration(s) {
    const start = num(s, 'start'), end = num(s, 'end');
    const source = literal(reflectGet(s, 'source'));
    const exported = optional(reflectGet(s, 'exported'), identifierOrLiteral);
    const attributes = list(reflectGet(s, 'attributes'), importAttribute);
    return made({ type: 'ExportAllDeclaration', start, end, source, exported, attributes });
}
