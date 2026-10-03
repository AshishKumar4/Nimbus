/**
 * tree.ts — the interpreter's own copy of the tree acorn parses.
 *
 * acorn builds its tree with the realm's built-ins: each node it makes is
 * pushed onto an array with Array.prototype.push. By the time the
 * interpreter parses, a program may have replaced that (the interpreter
 * loads on the first code a launch did not compile), and the replacement
 * receives acorn's nodes as they are built. It can make a field an accessor
 * that answers each read differently: an identifier's name that passes the
 * check refusing the interpreter's own binding names, then names one of them
 * when read again to be resolved. The analysis and the compiler read a node's
 * fields many times, so they read only this copy (Owned).
 *
 * The copy is made node by node, by the type acorn gave the node, which is
 * read first: each field acorn's typings declare for that type is read
 * exactly once and checked to be what they say (a string, a node of the
 * kinds the field may hold, a list of those), and nothing else is read. Every
 * object of the copy is frozen and inherits nothing, every list is a
 * SafeList, and no program code ever receives one. So the copy is an Owned
 * tree by construction, and the analysis takes nothing else.
 *
 * A literal's `value` is the one object acorn makes with a built-in a program
 * can replace (a RegExp, or a bigint through BigInt), so it is not copied: a
 * regular expression's is null (the compiler builds one from `regex` each
 * time it runs), and a bigint's is made again from its `bigint` text.
 */
import type {
  AnonymousClassDeclaration, AnonymousFunctionDeclaration, AnyNode, ArrayExpression, ArrayPattern, ArrowFunctionExpression,
  AssignmentExpression, AssignmentOperator, AssignmentPattern, AssignmentProperty, AwaitExpression, BinaryExpression, BinaryOperator,
  BlockStatement, BreakStatement, CallExpression, CatchClause, ChainExpression, ClassBody, ClassDeclaration, ClassExpression,
  ConditionalExpression, ContinueStatement, DebuggerStatement, Declaration, DoWhileStatement, EmptyStatement, ExportAllDeclaration,
  ExportDefaultDeclaration, ExportNamedDeclaration, ExportSpecifier, Expression, ExpressionStatement, ForInStatement, ForOfStatement,
  ForStatement, FunctionDeclaration, FunctionExpression, Identifier, IfStatement, ImportAttribute, ImportDeclaration,
  ImportDefaultSpecifier, ImportExpression, ImportNamespaceSpecifier, ImportSpecifier, LabeledStatement, Literal, LogicalExpression,
  LogicalOperator, MemberExpression, MetaProperty, MethodDefinition, ModuleDeclaration, NewExpression, ObjectExpression, ObjectPattern,
  ParenthesizedExpression, Pattern, PrivateIdentifier, Program, Property, PropertyDefinition, RestElement, ReturnStatement,
  SequenceExpression, SourceLocation, SpreadElement, Statement, StaticBlock, Super, SwitchCase, SwitchStatement,
  TaggedTemplateExpression, TemplateElement, TemplateLiteral, ThisExpression, ThrowStatement, TryStatement, UnaryExpression,
  UnaryOperator, UpdateExpression, UpdateOperator, VariableDeclaration, VariableDeclarator, WhileStatement, WithStatement,
  YieldExpression,
} from 'acorn';
import type { FunctionNode } from './scope.js';
import {
  BigInt, Error, type SafeList, append, arrayIsArray, charCodeAt, newSafeList, objectAssign, objectFreeze, objectHasOwn, reflectGet,
  reflectSetPrototypeOf,
} from './intrinsics.js';

/**
 * A node of the copy: acorn's typing of it, every node in it owned and every
 * list a SafeList (so a tree acorn returned is not one).
 */
export type Owned<T extends AnyNode> = { readonly [K in keyof T]: OwnedField<T[K]> };
type OwnedField<V> =
  V extends AnyNode ? Owned<V>
  // A node's location and range, which the interpreter does not ask acorn for.
  : V extends SourceLocation | [number, number] ? V
  : V extends (infer E)[] ? SafeList<OwnedField<E>>
  : V;

/** Where the copy being made records its functions, for reparse.ts to find one by its offsets. */
let functions: SafeList<Owned<FunctionNode>> | null = null;

/** The interpreter's copy of a program acorn parsed. Each function in it is appended to `found`, if given. */
export function ownProgram(program: Program, found: SafeList<Owned<FunctionNode>> | null = null): Owned<Program> {
  // Reading a field can run a program's accessor, which can compile code of its own.
  const outer = functions;
  functions = found;
  try {
    return only(program, 'Program', copyProgram);
  } finally {
    functions = outer;
  }
}

/** The interpreter's copy of a function expression acorn parsed (a Function constructor's). */
export function ownFunctionExpression(node: FunctionExpression): Owned<FunctionExpression> {
  const outer = functions;
  functions = null;
  try {
    return only(node, 'FunctionExpression', copyFunctionExpression);
  } finally {
    functions = outer;
  }
}

function refuse(what: string): never {
  throw new Error(`interpreter: the parser produced ${what}`);
}

function describe(type: unknown): string {
  return typeof type === 'string' ? `a ${type}` : `a node whose type is a ${typeof type}`;
}

// ── Fields ──

function sourceOf(value: unknown): object {
  if (typeof value !== 'object' || value === null || arrayIsArray(value)) return refuse('a node that is not an object');
  return value;
}

function num(source: object, key: string): number {
  const value = reflectGet(source, key);
  return typeof value === 'number' ? value : refuse(`a ${key} that is not a number`);
}

function str(source: object, key: string): string {
  const value = reflectGet(source, key);
  return typeof value === 'string' ? value : refuse(`a ${key} that is not a string`);
}

function bool(source: object, key: string): boolean {
  const value = reflectGet(source, key);
  return typeof value === 'boolean' ? value : refuse(`a ${key} that is not a boolean`);
}

function optionalString(source: object, key: string): string | undefined {
  const value = reflectGet(source, key);
  return value === undefined || typeof value === 'string' ? value : refuse(`a ${key} that is not a string`);
}

/** Whether `value` is one of the members `table` lists (each member of T, and only those). */
function isMember<T extends string>(table: { readonly [K in T]: true }, value: string): value is T {
  return objectHasOwn(table, value);
}

function member<T extends string>(table: { readonly [K in T]: true }, value: unknown, what: string): T {
  if (typeof value === 'string' && isMember(table, value)) return value;
  return refuse(`an unknown ${what}`);
}

const SOURCE_TYPES: { readonly [K in Program['sourceType']]: true } = { script: true, module: true };
const DECLARATION_KINDS: { readonly [K in VariableDeclaration['kind']]: true } = { var: true, let: true, const: true, using: true, 'await using': true };
const PROPERTY_KINDS: { readonly [K in Property['kind']]: true } = { init: true, get: true, set: true };
const METHOD_KINDS: { readonly [K in MethodDefinition['kind']]: true } = { constructor: true, method: true, get: true, set: true };
const UNARY: { readonly [K in UnaryOperator]: true } = { '-': true, '+': true, '!': true, '~': true, typeof: true, void: true, delete: true };
const UPDATE: { readonly [K in UpdateOperator]: true } = { '++': true, '--': true };
const BINARY: { readonly [K in BinaryOperator]: true } = {
  '==': true, '!=': true, '===': true, '!==': true, '<': true, '<=': true, '>': true, '>=': true, '<<': true, '>>': true, '>>>': true,
  '+': true, '-': true, '*': true, '/': true, '%': true, '|': true, '^': true, '&': true, in: true, instanceof: true, '**': true,
};
const ASSIGNMENT: { readonly [K in AssignmentOperator]: true } = {
  '=': true, '+=': true, '-=': true, '*=': true, '/=': true, '%=': true, '<<=': true, '>>=': true, '>>>=': true, '|=': true, '^=': true,
  '&=': true, '**=': true, '||=': true, '&&=': true, '??=': true,
};
const LOGICAL: { readonly [K in LogicalOperator]: true } = { '||': true, '&&': true, '??': true };

/**
 * `fields` as an object that inherits nothing, frozen: no field of it is
 * looked up through a prototype, or changed. The analysis and the compiler
 * read every node many times, so it is made the way V8 reads fastest: an
 * empty object given a null prototype, then the fields, in the same order
 * for every node of a kind, so that they share one hidden class.
 * Object.create(null) makes a dictionary instead, and a literal whose
 * prototype is changed afterwards gets a hidden class of its own.
 */
function made<T extends object>(fields: T): T {
  const node = {};
  reflectSetPrototypeOf(node, null);
  const owned = objectAssign(node, fields);
  objectFreeze(owned);
  return owned;
}

function list<T>(value: unknown, copy: (item: unknown) => T): SafeList<T> {
  if (!arrayIsArray(value)) return refuse('a list that is not an array');
  const length = value.length;
  const out = newSafeList<T>();
  for (let i = 0; i < length; i++) append(out, copy(reflectGet(value, i)));
  objectFreeze(out);
  return out;
}

function optional<T>(value: unknown, copy: (value: unknown) => T): T | null {
  return value === null || value === undefined ? null : copy(value);
}

/** A node of one type. */
function only<T>(value: unknown, type: string, copy: (source: object) => T): T {
  const source = sourceOf(value);
  const actual = reflectGet(source, 'type');
  return actual === type ? copy(source) : refuse(`${describe(actual)} where a ${type} goes`);
}

// ── Kinds of node a field holds ──

function expressionOf(s: object, type: unknown): Owned<Expression> | null {
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

function declarationOf(s: object, type: unknown): Owned<Declaration> | null {
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

function statementOf(s: object, type: unknown): Owned<Statement> | null {
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

function moduleDeclarationOf(s: object, type: unknown): Owned<ModuleDeclaration> | null {
  switch (type) {
    case 'ImportDeclaration': return copyImportDeclaration(s);
    case 'ExportNamedDeclaration': return copyExportNamedDeclaration(s);
    case 'ExportDefaultDeclaration': return copyExportDefaultDeclaration(s);
    case 'ExportAllDeclaration': return copyExportAllDeclaration(s);
    default: return null;
  }
}

function patternOf(s: object, type: unknown): Owned<Pattern> | null {
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

function expression(value: unknown): Owned<Expression> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}

function statement(value: unknown): Owned<Statement> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  return statementOf(s, type) ?? refuse(`${describe(type)} where a statement goes`);
}

function pattern(value: unknown): Owned<Pattern> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  return patternOf(s, type) ?? refuse(`${describe(type)} where a pattern goes`);
}

function statementOrModuleDeclaration(value: unknown): Owned<Statement> | Owned<ModuleDeclaration> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  return statementOf(s, type) ?? moduleDeclarationOf(s, type) ?? refuse(`${describe(type)} where a statement goes`);
}

function declaration(value: unknown): Owned<Declaration> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  return declarationOf(s, type) ?? refuse(`${describe(type)} where a declaration goes`);
}

function expressionOrSpread(value: unknown): Owned<Expression> | Owned<SpreadElement> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'SpreadElement') return copySpreadElement(s);
  return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}

function expressionOrPrivate(value: unknown): Owned<Expression> | Owned<PrivateIdentifier> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'PrivateIdentifier') return copyPrivateIdentifier(s);
  return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}

function expressionOrSuper(value: unknown): Owned<Expression> | Owned<Super> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'Super') return copySuper(s);
  return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}

function variablesOrExpression(value: unknown): Owned<VariableDeclaration> | Owned<Expression> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'VariableDeclaration') return copyVariableDeclaration(s);
  return expressionOf(s, type) ?? refuse(`${describe(type)} where an expression goes`);
}

function variablesOrPattern(value: unknown): Owned<VariableDeclaration> | Owned<Pattern> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'VariableDeclaration') return copyVariableDeclaration(s);
  return patternOf(s, type) ?? refuse(`${describe(type)} where a pattern goes`);
}

function blockOrExpression(value: unknown): Owned<BlockStatement> | Owned<Expression> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'BlockStatement') return copyBlockStatement(s);
  return expressionOf(s, type) ?? refuse(`${describe(type)} where a function body goes`);
}

function propertyOrSpread(value: unknown): Owned<Property> | Owned<SpreadElement> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'Property') return copyProperty(s);
  if (type === 'SpreadElement') return copySpreadElement(s);
  return refuse(`${describe(type)} where a property goes`);
}

function propertyPatternOrRest(value: unknown): Owned<AssignmentProperty> | Owned<RestElement> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'Property') return copyAssignmentProperty(s);
  if (type === 'RestElement') return copyRestElement(s);
  return refuse(`${describe(type)} where a property goes`);
}

function classElement(value: unknown): Owned<MethodDefinition> | Owned<PropertyDefinition> | Owned<StaticBlock> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'MethodDefinition') return copyMethodDefinition(s);
  if (type === 'PropertyDefinition') return copyPropertyDefinition(s);
  if (type === 'StaticBlock') return copyStaticBlock(s);
  return refuse(`${describe(type)} where a class element goes`);
}

function memberOrCall(value: unknown): Owned<MemberExpression> | Owned<CallExpression> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'MemberExpression') return copyMemberExpression(s);
  if (type === 'CallExpression') return copyCallExpression(s);
  return refuse(`${describe(type)} where an optional chain goes`);
}

function identifierOrLiteral(value: unknown): Owned<Identifier> | Owned<Literal> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'Identifier') return copyIdentifier(s);
  if (type === 'Literal') return copyLiteral(s);
  return refuse(`${describe(type)} where a module export name goes`);
}

function importSpecifier(value: unknown): Owned<ImportSpecifier> | Owned<ImportDefaultSpecifier> | Owned<ImportNamespaceSpecifier> {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'ImportSpecifier') return copyImportSpecifier(s);
  if (type === 'ImportDefaultSpecifier') return copyImportDefaultSpecifier(s);
  if (type === 'ImportNamespaceSpecifier') return copyImportNamespaceSpecifier(s);
  return refuse(`${describe(type)} where an import specifier goes`);
}

function defaultExport(value: unknown): Owned<ExportDefaultDeclaration>['declaration'] {
  const s = sourceOf(value);
  const type = reflectGet(s, 'type');
  if (type === 'FunctionDeclaration') return copyFunctionDeclaration(s);
  if (type === 'ClassDeclaration') return copyClassDeclaration(s);
  return expressionOf(s, type) ?? refuse(`${describe(type)} where a default export goes`);
}

const identifier = (value: unknown): Owned<Identifier> => only(value, 'Identifier', copyIdentifier);
const literal = (value: unknown): Owned<Literal> => only(value, 'Literal', copyLiteral);
const block = (value: unknown): Owned<BlockStatement> => only(value, 'BlockStatement', copyBlockStatement);

// ── Nodes, by type ──

function copyProgram(s: object): Owned<Program> {
  const start = num(s, 'start'), end = num(s, 'end');
  const body = list(reflectGet(s, 'body'), statementOrModuleDeclaration);
  const sourceType = member(SOURCE_TYPES, reflectGet(s, 'sourceType'), 'source type');
  return made({ type: 'Program', start, end, body, sourceType });
}

function copyIdentifier(s: object): Owned<Identifier> {
  const start = num(s, 'start'), end = num(s, 'end'), name = str(s, 'name');
  // The interpreter's own bindings ('%this', '*default*', '#field') have names no identifier can have.
  const first = charCodeAt(name, 0);
  if (first === 0x25 || first === 0x2a || first === 0x23) refuse(`the identifier ${name}`);
  return made({ type: 'Identifier', start, end, name });
}

function copyPrivateIdentifier(s: object): Owned<PrivateIdentifier> {
  const start = num(s, 'start'), end = num(s, 'end'), name = str(s, 'name');
  return made({ type: 'PrivateIdentifier', start, end, name });
}

function copyLiteral(s: object): Owned<Literal> {
  const start = num(s, 'start'), end = num(s, 'end');
  const value = reflectGet(s, 'value');
  const raw = optionalString(s, 'raw');
  const regex = optional(reflectGet(s, 'regex'), regexRecord);
  const bigint = optionalString(s, 'bigint');
  if (bigint !== undefined) return made({ type: 'Literal', start, end, value: BigInt(bigint), raw, bigint });
  if (regex !== null) return made({ type: 'Literal', start, end, value: null, raw, regex });
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return made({ type: 'Literal', start, end, value, raw });
  }
  return refuse('a literal whose value is an object');
}

function regexRecord(value: unknown): { readonly pattern: string; readonly flags: string } {
  const s = sourceOf(value);
  const pattern = str(s, 'pattern'), flags = str(s, 'flags');
  return made({ pattern, flags });
}

function copyExpressionStatement(s: object): Owned<ExpressionStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const node = expression(reflectGet(s, 'expression'));
  const directive = optionalString(s, 'directive');
  return made({ type: 'ExpressionStatement', start, end, expression: node, directive });
}

function copyBlockStatement(s: object): Owned<BlockStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const body = list(reflectGet(s, 'body'), statement);
  return made({ type: 'BlockStatement', start, end, body });
}

function copyEmptyStatement(s: object): Owned<EmptyStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  return made({ type: 'EmptyStatement', start, end });
}

function copyDebuggerStatement(s: object): Owned<DebuggerStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  return made({ type: 'DebuggerStatement', start, end });
}

function copyWithStatement(s: object): Owned<WithStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const object = expression(reflectGet(s, 'object'));
  const body = statement(reflectGet(s, 'body'));
  return made({ type: 'WithStatement', start, end, object, body });
}

function copyReturnStatement(s: object): Owned<ReturnStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const argument = optional(reflectGet(s, 'argument'), expression);
  return made({ type: 'ReturnStatement', start, end, argument });
}

function copyLabeledStatement(s: object): Owned<LabeledStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const label = identifier(reflectGet(s, 'label'));
  const body = statement(reflectGet(s, 'body'));
  return made({ type: 'LabeledStatement', start, end, label, body });
}

function copyBreakStatement(s: object): Owned<BreakStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const label = optional(reflectGet(s, 'label'), identifier);
  return made({ type: 'BreakStatement', start, end, label });
}

function copyContinueStatement(s: object): Owned<ContinueStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const label = optional(reflectGet(s, 'label'), identifier);
  return made({ type: 'ContinueStatement', start, end, label });
}

function copyIfStatement(s: object): Owned<IfStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const test = expression(reflectGet(s, 'test'));
  const consequent = statement(reflectGet(s, 'consequent'));
  const alternate = optional(reflectGet(s, 'alternate'), statement);
  return made({ type: 'IfStatement', start, end, test, consequent, alternate });
}

function copySwitchStatement(s: object): Owned<SwitchStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const discriminant = expression(reflectGet(s, 'discriminant'));
  const cases = list(reflectGet(s, 'cases'), (item) => only(item, 'SwitchCase', copySwitchCase));
  return made({ type: 'SwitchStatement', start, end, discriminant, cases });
}

function copySwitchCase(s: object): Owned<SwitchCase> {
  const start = num(s, 'start'), end = num(s, 'end');
  const test = optional(reflectGet(s, 'test'), expression);
  const consequent = list(reflectGet(s, 'consequent'), statement);
  return made({ type: 'SwitchCase', start, end, test, consequent });
}

function copyThrowStatement(s: object): Owned<ThrowStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const argument = expression(reflectGet(s, 'argument'));
  return made({ type: 'ThrowStatement', start, end, argument });
}

function copyTryStatement(s: object): Owned<TryStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const tried = block(reflectGet(s, 'block'));
  const handler = optional(reflectGet(s, 'handler'), (item) => only(item, 'CatchClause', copyCatchClause));
  const finalizer = optional(reflectGet(s, 'finalizer'), block);
  return made({ type: 'TryStatement', start, end, block: tried, handler, finalizer });
}

function copyCatchClause(s: object): Owned<CatchClause> {
  const start = num(s, 'start'), end = num(s, 'end');
  const param = optional(reflectGet(s, 'param'), pattern);
  const body = block(reflectGet(s, 'body'));
  return made({ type: 'CatchClause', start, end, param, body });
}

function copyWhileStatement(s: object): Owned<WhileStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const test = expression(reflectGet(s, 'test'));
  const body = statement(reflectGet(s, 'body'));
  return made({ type: 'WhileStatement', start, end, test, body });
}

function copyDoWhileStatement(s: object): Owned<DoWhileStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const body = statement(reflectGet(s, 'body'));
  const test = expression(reflectGet(s, 'test'));
  return made({ type: 'DoWhileStatement', start, end, body, test });
}

function copyForStatement(s: object): Owned<ForStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const init = optional(reflectGet(s, 'init'), variablesOrExpression);
  const test = optional(reflectGet(s, 'test'), expression);
  const update = optional(reflectGet(s, 'update'), expression);
  const body = statement(reflectGet(s, 'body'));
  return made({ type: 'ForStatement', start, end, init, test, update, body });
}

function copyForInStatement(s: object): Owned<ForInStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const left = variablesOrPattern(reflectGet(s, 'left'));
  const right = expression(reflectGet(s, 'right'));
  const body = statement(reflectGet(s, 'body'));
  return made({ type: 'ForInStatement', start, end, left, right, body });
}

function copyForOfStatement(s: object): Owned<ForOfStatement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const left = variablesOrPattern(reflectGet(s, 'left'));
  const right = expression(reflectGet(s, 'right'));
  const body = statement(reflectGet(s, 'body'));
  const isAwait = bool(s, 'await');
  return made({ type: 'ForOfStatement', start, end, left, right, body, await: isAwait });
}

function copyFunctionDeclaration(s: object): Owned<FunctionDeclaration> | Owned<AnonymousFunctionDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const id = optional(reflectGet(s, 'id'), identifier);
  const params = list(reflectGet(s, 'params'), pattern);
  const body = block(reflectGet(s, 'body'));
  const generator = bool(s, 'generator'), isExpression = bool(s, 'expression'), isAsync = bool(s, 'async');
  const node: Owned<FunctionDeclaration> | Owned<AnonymousFunctionDeclaration> = id === null
    ? made({ type: 'FunctionDeclaration', start, end, id, params, body, generator, expression: isExpression, async: isAsync })
    : made({ type: 'FunctionDeclaration', start, end, id, params, body, generator, expression: isExpression, async: isAsync });
  if (functions !== null) append(functions, node);
  return node;
}

function copyVariableDeclaration(s: object): Owned<VariableDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const declarations = list(reflectGet(s, 'declarations'), (item) => only(item, 'VariableDeclarator', copyVariableDeclarator));
  const kind = member(DECLARATION_KINDS, reflectGet(s, 'kind'), 'declaration kind');
  return made({ type: 'VariableDeclaration', start, end, declarations, kind });
}

function copyVariableDeclarator(s: object): Owned<VariableDeclarator> {
  const start = num(s, 'start'), end = num(s, 'end');
  const id = pattern(reflectGet(s, 'id'));
  const init = optional(reflectGet(s, 'init'), expression);
  return made({ type: 'VariableDeclarator', start, end, id, init });
}

function copyClassDeclaration(s: object): Owned<ClassDeclaration> | Owned<AnonymousClassDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const id = optional(reflectGet(s, 'id'), identifier);
  const superClass = optional(reflectGet(s, 'superClass'), expression);
  const body = only(reflectGet(s, 'body'), 'ClassBody', copyClassBody);
  return id === null
    ? made({ type: 'ClassDeclaration', start, end, id, superClass, body })
    : made({ type: 'ClassDeclaration', start, end, id, superClass, body });
}

function copyThisExpression(s: object): Owned<ThisExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  return made({ type: 'ThisExpression', start, end });
}

function copySuper(s: object): Owned<Super> {
  const start = num(s, 'start'), end = num(s, 'end');
  return made({ type: 'Super', start, end });
}

function copyArrayExpression(s: object): Owned<ArrayExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const elements = list(reflectGet(s, 'elements'), (item) => optional(item, expressionOrSpread));
  return made({ type: 'ArrayExpression', start, end, elements });
}

function copyObjectExpression(s: object): Owned<ObjectExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const properties = list(reflectGet(s, 'properties'), propertyOrSpread);
  return made({ type: 'ObjectExpression', start, end, properties });
}

function copyProperty(s: object): Owned<Property> {
  const start = num(s, 'start'), end = num(s, 'end');
  const key = expression(reflectGet(s, 'key'));
  const value = expression(reflectGet(s, 'value'));
  const kind = member(PROPERTY_KINDS, reflectGet(s, 'kind'), 'property kind');
  const method = bool(s, 'method'), shorthand = bool(s, 'shorthand'), computed = bool(s, 'computed');
  return made({ type: 'Property', start, end, key, value, kind, method, shorthand, computed });
}

function copyFunctionExpression(s: object): Owned<FunctionExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const id = optional(reflectGet(s, 'id'), identifier);
  const params = list(reflectGet(s, 'params'), pattern);
  const body = block(reflectGet(s, 'body'));
  const generator = bool(s, 'generator'), isExpression = bool(s, 'expression'), isAsync = bool(s, 'async');
  const node: Owned<FunctionExpression> = made({
    type: 'FunctionExpression', start, end, id, params, body, generator, expression: isExpression, async: isAsync,
  });
  if (functions !== null) append(functions, node);
  return node;
}

function copyArrowFunctionExpression(s: object): Owned<ArrowFunctionExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const id = optional(reflectGet(s, 'id'), identifier);
  const params = list(reflectGet(s, 'params'), pattern);
  const body = blockOrExpression(reflectGet(s, 'body'));
  const generator = bool(s, 'generator'), isExpression = bool(s, 'expression'), isAsync = bool(s, 'async');
  const node: Owned<ArrowFunctionExpression> = made({
    type: 'ArrowFunctionExpression', start, end, id, params, body, generator, expression: isExpression, async: isAsync,
  });
  if (functions !== null) append(functions, node);
  return node;
}

function copyUnaryExpression(s: object): Owned<UnaryExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const operator = member(UNARY, reflectGet(s, 'operator'), 'unary operator');
  const prefix = bool(s, 'prefix');
  const argument = expression(reflectGet(s, 'argument'));
  return made({ type: 'UnaryExpression', start, end, operator, prefix, argument });
}

function copyUpdateExpression(s: object): Owned<UpdateExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const operator = member(UPDATE, reflectGet(s, 'operator'), 'update operator');
  const prefix = bool(s, 'prefix');
  const argument = expression(reflectGet(s, 'argument'));
  return made({ type: 'UpdateExpression', start, end, operator, prefix, argument });
}

function copyBinaryExpression(s: object): Owned<BinaryExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const operator = member(BINARY, reflectGet(s, 'operator'), 'binary operator');
  const left = expressionOrPrivate(reflectGet(s, 'left'));
  const right = expression(reflectGet(s, 'right'));
  return made({ type: 'BinaryExpression', start, end, operator, left, right });
}

function copyAssignmentExpression(s: object): Owned<AssignmentExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const operator = member(ASSIGNMENT, reflectGet(s, 'operator'), 'assignment operator');
  const left = pattern(reflectGet(s, 'left'));
  const right = expression(reflectGet(s, 'right'));
  return made({ type: 'AssignmentExpression', start, end, operator, left, right });
}

function copyLogicalExpression(s: object): Owned<LogicalExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const operator = member(LOGICAL, reflectGet(s, 'operator'), 'logical operator');
  const left = expression(reflectGet(s, 'left'));
  const right = expression(reflectGet(s, 'right'));
  return made({ type: 'LogicalExpression', start, end, operator, left, right });
}

function copyMemberExpression(s: object): Owned<MemberExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const object = expressionOrSuper(reflectGet(s, 'object'));
  const property = expressionOrPrivate(reflectGet(s, 'property'));
  const computed = bool(s, 'computed'), isOptional = bool(s, 'optional');
  return made({ type: 'MemberExpression', start, end, object, property, computed, optional: isOptional });
}

function copyConditionalExpression(s: object): Owned<ConditionalExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const test = expression(reflectGet(s, 'test'));
  const consequent = expression(reflectGet(s, 'consequent'));
  const alternate = expression(reflectGet(s, 'alternate'));
  return made({ type: 'ConditionalExpression', start, end, test, consequent, alternate });
}

function copyCallExpression(s: object): Owned<CallExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const callee = expressionOrSuper(reflectGet(s, 'callee'));
  const args = list(reflectGet(s, 'arguments'), expressionOrSpread);
  const isOptional = bool(s, 'optional');
  return made({ type: 'CallExpression', start, end, callee, arguments: args, optional: isOptional });
}

function copyNewExpression(s: object): Owned<NewExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const callee = expression(reflectGet(s, 'callee'));
  const args = list(reflectGet(s, 'arguments'), expressionOrSpread);
  return made({ type: 'NewExpression', start, end, callee, arguments: args });
}

function copySequenceExpression(s: object): Owned<SequenceExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const expressions = list(reflectGet(s, 'expressions'), expression);
  return made({ type: 'SequenceExpression', start, end, expressions });
}

function copySpreadElement(s: object): Owned<SpreadElement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const argument = expression(reflectGet(s, 'argument'));
  return made({ type: 'SpreadElement', start, end, argument });
}

function copyYieldExpression(s: object): Owned<YieldExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const argument = optional(reflectGet(s, 'argument'), expression);
  const delegate = bool(s, 'delegate');
  return made({ type: 'YieldExpression', start, end, argument, delegate });
}

function copyTemplateLiteral(s: object): Owned<TemplateLiteral> {
  const start = num(s, 'start'), end = num(s, 'end');
  const quasis = list(reflectGet(s, 'quasis'), (item) => only(item, 'TemplateElement', copyTemplateElement));
  const expressions = list(reflectGet(s, 'expressions'), expression);
  return made({ type: 'TemplateLiteral', start, end, quasis, expressions });
}

function copyTemplateElement(s: object): Owned<TemplateElement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const tail = bool(s, 'tail');
  const text = sourceOf(reflectGet(s, 'value'));
  const cooked = reflectGet(text, 'cooked');
  const raw = str(text, 'raw');
  // An invalid escape in a tagged template: no cooked string.
  if (cooked !== null && cooked !== undefined && typeof cooked !== 'string') refuse('a cooked template string that is not a string');
  return made({ type: 'TemplateElement', start, end, tail, value: made({ cooked, raw }) });
}

function copyTaggedTemplateExpression(s: object): Owned<TaggedTemplateExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const tag = expression(reflectGet(s, 'tag'));
  const quasi = only(reflectGet(s, 'quasi'), 'TemplateLiteral', copyTemplateLiteral);
  return made({ type: 'TaggedTemplateExpression', start, end, tag, quasi });
}

function copyObjectPattern(s: object): Owned<ObjectPattern> {
  const start = num(s, 'start'), end = num(s, 'end');
  const properties = list(reflectGet(s, 'properties'), propertyPatternOrRest);
  return made({ type: 'ObjectPattern', start, end, properties });
}

function copyAssignmentProperty(s: object): Owned<AssignmentProperty> {
  const start = num(s, 'start'), end = num(s, 'end');
  const key = expression(reflectGet(s, 'key'));
  const value = pattern(reflectGet(s, 'value'));
  const kind = reflectGet(s, 'kind');
  const method = reflectGet(s, 'method');
  const shorthand = bool(s, 'shorthand'), computed = bool(s, 'computed');
  if (kind !== 'init' || method !== false) return refuse('a pattern property that is a method or accessor');
  return made({ type: 'Property', start, end, key, value, kind, method, shorthand, computed });
}

function copyArrayPattern(s: object): Owned<ArrayPattern> {
  const start = num(s, 'start'), end = num(s, 'end');
  const elements = list(reflectGet(s, 'elements'), (item) => optional(item, pattern));
  return made({ type: 'ArrayPattern', start, end, elements });
}

function copyRestElement(s: object): Owned<RestElement> {
  const start = num(s, 'start'), end = num(s, 'end');
  const argument = pattern(reflectGet(s, 'argument'));
  return made({ type: 'RestElement', start, end, argument });
}

function copyAssignmentPattern(s: object): Owned<AssignmentPattern> {
  const start = num(s, 'start'), end = num(s, 'end');
  const left = pattern(reflectGet(s, 'left'));
  const right = expression(reflectGet(s, 'right'));
  return made({ type: 'AssignmentPattern', start, end, left, right });
}

function copyClassExpression(s: object): Owned<ClassExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const id = optional(reflectGet(s, 'id'), identifier);
  const superClass = optional(reflectGet(s, 'superClass'), expression);
  const body = only(reflectGet(s, 'body'), 'ClassBody', copyClassBody);
  return made({ type: 'ClassExpression', start, end, id, superClass, body });
}

function copyClassBody(s: object): Owned<ClassBody> {
  const start = num(s, 'start'), end = num(s, 'end');
  const body = list(reflectGet(s, 'body'), classElement);
  return made({ type: 'ClassBody', start, end, body });
}

function copyMethodDefinition(s: object): Owned<MethodDefinition> {
  const start = num(s, 'start'), end = num(s, 'end');
  const key = expressionOrPrivate(reflectGet(s, 'key'));
  const value = only(reflectGet(s, 'value'), 'FunctionExpression', copyFunctionExpression);
  const kind = member(METHOD_KINDS, reflectGet(s, 'kind'), 'method kind');
  const computed = bool(s, 'computed'), isStatic = bool(s, 'static');
  return made({ type: 'MethodDefinition', start, end, key, value, kind, computed, static: isStatic });
}

function copyPropertyDefinition(s: object): Owned<PropertyDefinition> {
  const start = num(s, 'start'), end = num(s, 'end');
  const key = expressionOrPrivate(reflectGet(s, 'key'));
  const value = optional(reflectGet(s, 'value'), expression);
  const computed = bool(s, 'computed'), isStatic = bool(s, 'static');
  return made({ type: 'PropertyDefinition', start, end, key, value, computed, static: isStatic });
}

function copyStaticBlock(s: object): Owned<StaticBlock> {
  const start = num(s, 'start'), end = num(s, 'end');
  const body = list(reflectGet(s, 'body'), statement);
  return made({ type: 'StaticBlock', start, end, body });
}

function copyMetaProperty(s: object): Owned<MetaProperty> {
  const start = num(s, 'start'), end = num(s, 'end');
  const meta = identifier(reflectGet(s, 'meta'));
  const property = identifier(reflectGet(s, 'property'));
  return made({ type: 'MetaProperty', start, end, meta, property });
}

function copyAwaitExpression(s: object): Owned<AwaitExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const argument = expression(reflectGet(s, 'argument'));
  return made({ type: 'AwaitExpression', start, end, argument });
}

function copyChainExpression(s: object): Owned<ChainExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const node = memberOrCall(reflectGet(s, 'expression'));
  return made({ type: 'ChainExpression', start, end, expression: node });
}

function copyImportExpression(s: object): Owned<ImportExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const source = expression(reflectGet(s, 'source'));
  const options = optional(reflectGet(s, 'options'), expression);
  return made({ type: 'ImportExpression', start, end, source, options });
}

function copyParenthesizedExpression(s: object): Owned<ParenthesizedExpression> {
  const start = num(s, 'start'), end = num(s, 'end');
  const node = expression(reflectGet(s, 'expression'));
  return made({ type: 'ParenthesizedExpression', start, end, expression: node });
}

function copyImportDeclaration(s: object): Owned<ImportDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const specifiers = list(reflectGet(s, 'specifiers'), importSpecifier);
  const source = literal(reflectGet(s, 'source'));
  const attributes = list(reflectGet(s, 'attributes'), importAttribute);
  return made({ type: 'ImportDeclaration', start, end, specifiers, source, attributes });
}

function copyImportSpecifier(s: object): Owned<ImportSpecifier> {
  const start = num(s, 'start'), end = num(s, 'end');
  const importedSource = reflectGet(s, 'imported');
  const imported = identifierOrLiteral(importedSource);
  const localSource = reflectGet(s, 'local');
  // acorn gives `import { x }` one node for both names: it is copied, and read, once.
  const local = localSource !== importedSource ? identifier(localSource)
    : imported.type === 'Identifier' ? imported : refuse('a string literal as an imported binding');
  return made({ type: 'ImportSpecifier', start, end, imported, local });
}

function copyImportDefaultSpecifier(s: object): Owned<ImportDefaultSpecifier> {
  const start = num(s, 'start'), end = num(s, 'end');
  const local = identifier(reflectGet(s, 'local'));
  return made({ type: 'ImportDefaultSpecifier', start, end, local });
}

function copyImportNamespaceSpecifier(s: object): Owned<ImportNamespaceSpecifier> {
  const start = num(s, 'start'), end = num(s, 'end');
  const local = identifier(reflectGet(s, 'local'));
  return made({ type: 'ImportNamespaceSpecifier', start, end, local });
}

function importAttribute(value: unknown): Owned<ImportAttribute> {
  return only(value, 'ImportAttribute', copyImportAttribute);
}

function copyImportAttribute(s: object): Owned<ImportAttribute> {
  const start = num(s, 'start'), end = num(s, 'end');
  const key = identifierOrLiteral(reflectGet(s, 'key'));
  const value = literal(reflectGet(s, 'value'));
  return made({ type: 'ImportAttribute', start, end, key, value });
}

function copyExportNamedDeclaration(s: object): Owned<ExportNamedDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const node = optional(reflectGet(s, 'declaration'), declaration);
  const specifiers = list(reflectGet(s, 'specifiers'), (item) => only(item, 'ExportSpecifier', copyExportSpecifier));
  const source = optional(reflectGet(s, 'source'), literal);
  const attributes = list(reflectGet(s, 'attributes'), importAttribute);
  return made({ type: 'ExportNamedDeclaration', start, end, declaration: node, specifiers, source, attributes });
}

function copyExportSpecifier(s: object): Owned<ExportSpecifier> {
  const start = num(s, 'start'), end = num(s, 'end');
  const localSource = reflectGet(s, 'local');
  const local = identifierOrLiteral(localSource);
  const exportedSource = reflectGet(s, 'exported');
  // acorn gives `export { x }` one node for both names: it is copied, and read, once.
  const exported = exportedSource === localSource ? local : identifierOrLiteral(exportedSource);
  return made({ type: 'ExportSpecifier', start, end, local, exported });
}

function copyExportDefaultDeclaration(s: object): Owned<ExportDefaultDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const node = defaultExport(reflectGet(s, 'declaration'));
  return made({ type: 'ExportDefaultDeclaration', start, end, declaration: node });
}

function copyExportAllDeclaration(s: object): Owned<ExportAllDeclaration> {
  const start = num(s, 'start'), end = num(s, 'end');
  const source = literal(reflectGet(s, 'source'));
  const exported = optional(reflectGet(s, 'exported'), identifierOrLiteral);
  const attributes = list(reflectGet(s, 'attributes'), importAttribute);
  return made({ type: 'ExportAllDeclaration', start, end, source, exported, attributes });
}
