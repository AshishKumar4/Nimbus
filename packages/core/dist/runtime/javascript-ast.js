import { Parser, parse, tokenizer, tokTypes } from 'acorn';
/** How an ES module is parsed. */
export const MODULE_PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true };
/** How a program Node would run is parsed (as a module, else as a CommonJS script): what either allows. */
export const PROGRAM_PARSE_OPTIONS = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
};
export function parseJavaScriptModule(source) {
    const program = parse(source, MODULE_PARSE_OPTIONS);
    // Program declares no index signature; the guard gives it AstNode's keyed view.
    if (!isAstNode(program))
        throw new TypeError(`acorn parsed a ${program.type}, not a node`);
    return program;
}
/**
 * A program as Node would run it: an ES module, or a CommonJS script (whose
 * top level may `return`); null when it is neither.
 */
export function parseJavaScriptProgram(source) {
    try {
        return parse(source, { ...PROGRAM_PARSE_OPTIONS, sourceType: 'module' });
    }
    catch {
        try {
            return parse(source, { ...PROGRAM_PARSE_OPTIONS, sourceType: 'script' });
        }
        catch {
            return null;
        }
    }
}
const AcornParserClass = Parser;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** acorn, keeping no tree of the whole program (parseStatements). */
class StatementParser extends AcornParserClass {
    hooks = {};
    parseTopLevel(node) {
        const exports = Object.create(null);
        while (this.type !== tokTypes.eof) {
            const statement = this.parseStatement(null, true, exports);
            if (isAstNode(statement))
                this.hooks.onStatement?.(statement);
        }
        if (this.inModule) {
            for (const name of Object.keys(this.undefinedExports))
                this.raiseRecoverable(this.undefinedExports[name].start, `Export '${name}' is not defined`);
        }
        this.next();
        return this.finishNode(node, 'Program');
    }
    finishNode(node, type) {
        const finished = super.finishNode(node, type);
        if (isAstNode(finished)) {
            this.hooks.onNode?.(finished);
            if (FUNCTION_TYPES.has(type)) {
                const body = finished.body;
                if (isAstNode(body) && body.type === 'BlockStatement')
                    Reflect.set(body, 'body', []);
            }
        }
        return finished;
    }
}
/**
 * acorn's parse of `source` with no tree of the whole program held: each
 * top-level statement goes to the hooks as it is parsed and is not kept,
 * and each function's body is dropped once the function is finished (its
 * parameters stay, which acorn checks after). What is held at once is the
 * chain of functions being parsed and their code outside functions, so a
 * multi-MiB bundle parses in bounded memory (acorn's whole tree is 17 to 24
 * times its source). Throws acorn's SyntaxError, as `parse` does.
 */
export function parseStatements(source, options, hooks) {
    const parser = new StatementParser(options, source);
    parser.hooks = hooks;
    parser.parse();
}
/** Parentheses, `(0, f)`, `await` and `?.` do not change what is called. */
export function unwrapCallee(node) {
    let at = node;
    for (;;) {
        if (at.type === 'ParenthesizedExpression' || at.type === 'ChainExpression')
            at = at.expression;
        else if (at.type === 'SequenceExpression')
            at = at.expressions[at.expressions.length - 1];
        else if (at.type === 'AwaitExpression')
            at = at.argument;
        else
            return at;
    }
}
/** The name of the function a call reaches: `f`, `x.f`, `x['f']`, through {@link unwrapCallee}. */
export function calleeName(callee) {
    const at = unwrapCallee(callee);
    if (at.type === 'Identifier')
        return at.name;
    if (at.type !== 'MemberExpression')
        return null;
    if (!at.computed && at.property.type === 'Identifier')
        return at.property.name;
    return at.property.type === 'Literal' && typeof at.property.value === 'string' ? at.property.value : null;
}
/** Whether `source` holds a top-level `import` or `export` declaration. */
export function hasTopLevelModuleSyntax(source) {
    return walkTopLevelModuleTokens(source, (_token, declaration) => declaration !== null) === true;
}
/**
 * Walk `source`'s tokens tracking brace, paren and bracket depth, without
 * building an AST (a multi-MiB bundle chunk must fit a 48 MiB heap). `visit`
 * sees each token with whether it sits at top level and, for a top-level
 * `import` or `export` keyword, which declaration it opens: not `import(`,
 * not `import.meta`, and not a member named so (after `.` or `?.`). The token
 * after an `import` keyword is read to decide that and not visited. `visit`
 * returns true to stop the walk.
 *
 * Returns true when `visit` stopped it, false at the end of the source, and
 * null when the source does not tokenize.
 */
export function walkTopLevelModuleTokens(source, visit) {
    try {
        const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
        let braces = 0;
        let parens = 0;
        let brackets = 0;
        let previous = tokTypes.eof;
        const updateDepth = (type) => {
            if (type === tokTypes.braceL || type === tokTypes.dollarBraceL)
                braces++;
            else if (type === tokTypes.braceR)
                braces = Math.max(0, braces - 1);
            else if (type === tokTypes.parenL)
                parens++;
            else if (type === tokTypes.parenR)
                parens = Math.max(0, parens - 1);
            else if (type === tokTypes.bracketL)
                brackets++;
            else if (type === tokTypes.bracketR)
                brackets = Math.max(0, brackets - 1);
        };
        for (;;) {
            const token = tokens.getToken();
            const type = token.type;
            if (type === tokTypes.eof)
                return false;
            const topLevel = braces === 0 && parens === 0 && brackets === 0;
            const keyword = topLevel && previous !== tokTypes.dot && previous !== tokTypes.questionDot;
            previous = type;
            let declaration = null;
            if (keyword && type === tokTypes._export) {
                declaration = 'export';
            }
            else if (keyword && type === tokTypes._import) {
                const next = tokens.getToken();
                previous = next.type;
                updateDepth(next.type);
                if (next.type !== tokTypes.parenL && next.type !== tokTypes.dot)
                    declaration = 'import';
            }
            else {
                updateDepth(type);
            }
            if (visit(token, declaration, topLevel))
                return true;
        }
    }
    catch {
        return null;
    }
}
/**
 * `source` with `edits` applied, in source order. Edits may come in any
 * order and may insert (start === end), but never overlap: an overlap is a
 * rewrite that lost track of what it replaced, and throws.
 */
export function applySourceEdits(source, edits) {
    const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    const parts = [];
    let at = 0;
    for (const { start, end, text } of ordered) {
        if (start < at)
            throw new Error(`overlapping source edits at ${start}`);
        parts.push(source.slice(at, start), text);
        at = end;
    }
    parts.push(source.slice(at));
    return parts.join('');
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
/** Every node type acorn's AnyNode names: `satisfies` holds the list to acorn's types. */
const NODE_TYPES = new Set(Object.keys({
    ArrayExpression: true, ArrayPattern: true, ArrowFunctionExpression: true, AssignmentExpression: true,
    AssignmentPattern: true, AwaitExpression: true, BinaryExpression: true, BlockStatement: true, BreakStatement: true,
    CallExpression: true, CatchClause: true, ChainExpression: true, ClassBody: true, ClassDeclaration: true,
    ClassExpression: true, ConditionalExpression: true, ContinueStatement: true, DebuggerStatement: true,
    DoWhileStatement: true, EmptyStatement: true, ExportAllDeclaration: true, ExportDefaultDeclaration: true,
    ExportNamedDeclaration: true, ExportSpecifier: true, ExpressionStatement: true, ForInStatement: true,
    ForOfStatement: true, ForStatement: true, FunctionDeclaration: true, FunctionExpression: true, Identifier: true,
    IfStatement: true, ImportAttribute: true, ImportDeclaration: true, ImportDefaultSpecifier: true,
    ImportExpression: true, ImportNamespaceSpecifier: true, ImportSpecifier: true, LabeledStatement: true,
    Literal: true, LogicalExpression: true, MemberExpression: true, MetaProperty: true, MethodDefinition: true,
    NewExpression: true, ObjectExpression: true, ObjectPattern: true, ParenthesizedExpression: true,
    PrivateIdentifier: true, Program: true, Property: true, PropertyDefinition: true, RestElement: true,
    ReturnStatement: true, SequenceExpression: true, SpreadElement: true, StaticBlock: true, Super: true,
    SwitchCase: true, SwitchStatement: true, TaggedTemplateExpression: true, TemplateElement: true,
    TemplateLiteral: true, ThisExpression: true, ThrowStatement: true, TryStatement: true, UnaryExpression: true,
    UpdateExpression: true, VariableDeclaration: true, VariableDeclarator: true, WhileStatement: true,
    WithStatement: true, YieldExpression: true,
}));
/**
 * A node of a tree acorn parsed: an object whose `type` is one of acorn's
 * node types. Its other fields are acorn's, which this does not re-check.
 */
export function isAstNode(value) {
    return typeof value === 'object' && value !== null && 'type' in value
        && typeof value.type === 'string' && NODE_TYPES.has(value.type);
}
const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);
/** Each child node of `node`. */
export function forEachChild(node, visit) {
    for (const key of Object.keys(node)) {
        if (NON_CHILD_KEYS.has(key))
            continue;
        const child = Reflect.get(node, key);
        if (Array.isArray(child)) {
            const children = child;
            for (const c of children)
                if (isAstNode(c))
                    visit(c);
        }
        else if (isAstNode(child)) {
            visit(child);
        }
    }
}
/** Every node below `node`, functions included, in source order. */
export function forEachNode(node, visit) {
    visit(node);
    forEachChild(node, (child) => forEachNode(child, visit));
}
