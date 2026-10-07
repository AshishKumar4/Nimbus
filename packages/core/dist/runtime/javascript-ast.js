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
/**
 * The names Node's CommonJS wrapper binds: what a CommonJS module's top level
 * may not redeclare lexically, and what no ES module's scope has.
 */
export const COMMONJS_WRAPPER_NAMES = new Set(['exports', 'require', 'module', '__filename', '__dirname']);
/**
 * Whether Node runs `source`, whose extension and package "type" leave it
 * undecided, as an ES module: Node's syntax detection (doc/api/packages.md
 * "Syntax detection", on by default from v22.7.0), as src/node_contextify.cc
 * ContainsModuleSyntax decides it. Node compiles the source as CommonJS (a
 * file as the body of the wrapper function, whose parameters are the
 * wrapper's names; `--eval` code and stdin, `scope` 'eval', with none) and it
 * is CommonJS if that compiles. Otherwise V8's first error decides: one at
 * an `import` (not `import(`), an `export` or `import.meta` makes it a
 * module; one Node retries (a lexical redeclaration of a wrapper name, and
 * the errors a top-level `await` gives) makes it a module if it compiles as
 * one; any other leaves it CommonJS.
 *
 * Only an `import`, an `export`, `import.meta`, a top-level `await` or a
 * top-level lexical declaration can make the answer a module, so a walk of
 * the tokens answers every other source CommonJS without a parse (a
 * multi-MiB bundle must fit a 48 MiB heap). One that finds a top-level
 * `import` or `export`, or `import.meta`, before either of the others
 * answers module. Where that differs from Node (a syntax error before it;
 * an `import` or `export` nested in a block) the source compiles under
 * neither, and fails either way. The rest are compiled, by acorn in V8's
 * place (commonJsCompileError).
 */
export function containsModuleSyntax(source, scope = 'file') {
    const scan = unscopedAwaitScanner(source);
    const bindings = lexicalBindingScanner(scope === 'file' ? COMMONJS_WRAPPER_NAMES : new Set());
    let moduleSyntax = false;
    let candidate = false;
    // Tokenized as CommonJS is compiled: a script's tokens (a legacy octal is one).
    walkTopLevelModuleTokens(source, (token, syntax, topLevel) => {
        if (syntax !== null)
            moduleSyntax = true;
        else if (bindings(token, topLevel) || scan(token))
            candidate = true;
        return moduleSyntax || candidate;
    }, 'script');
    if (moduleSyntax)
        return true;
    if (!candidate && !scan.atEnd())
        return false;
    const error = commonJsCompileError(source, scope);
    if (error === null)
        return false;
    if (error.esModuleSyntax)
        return true;
    return compilesAsModuleAfter(source, error.at);
}
/**
 * A top-level lexical declaration's state, handed the tokens in order: true
 * for each name token in a `let`, `const` or `class` declaration's binding
 * part (its patterns, every declarator's, and a class's name) whose name,
 * escapes read, is one of `names`. A key in a pattern counts too: it only
 * asks for the compile, which settles it.
 */
function lexicalBindingScanner(names) {
    // In a declarator's target, or its value, from a `let` or `const` to the `;` after it.
    let declarator = 'none';
    let depth = 0;
    let className = false;
    let previous = tokTypes.eof;
    return (token, topLevel) => {
        const type = token.type;
        const after = previous;
        previous = type;
        if (className) {
            className = false;
            if (type === tokTypes.name && names.has(tokenName(token)))
                return true;
        }
        if (topLevel && after !== tokTypes.dot && after !== tokTypes.questionDot) {
            if (type === tokTypes._class)
                className = true;
            else if (type === tokTypes._const || (type === tokTypes.name && tokenName(token) === 'let')) {
                declarator = 'binding';
                depth = 0;
                return false;
            }
        }
        if (declarator === 'none')
            return false;
        if (type === tokTypes.braceL || type === tokTypes.dollarBraceL || type === tokTypes.parenL || type === tokTypes.bracketL)
            depth++;
        else if (type === tokTypes.braceR || type === tokTypes.parenR || type === tokTypes.bracketR)
            depth--;
        if (depth < 0 || (depth === 0 && type === tokTypes.semi))
            declarator = 'none';
        else if (depth === 0 && type === tokTypes.eq && declarator === 'binding')
            declarator = 'initializer';
        else if (depth === 0 && type === tokTypes.comma)
            declarator = 'binding';
        return declarator === 'binding' && type === tokTypes.name && names.has(tokenName(token));
    };
}
/** A name token's name, escapes read (acorn sets `value`, which its declarations leave out). */
function tokenName(token) {
    const value = Reflect.get(token, 'value');
    return typeof value === 'string' ? value : '';
}
/** acorn's messages for V8's errors at `import.meta` and at an `import` or `export` statement: a module's syntax. */
const MODULE_SYNTAX_ERRORS = new Set([
    "'import' and 'export' may appear only with 'sourceType: module'",
    "'import' and 'export' may only appear at the top level",
    "Cannot use 'import.meta' outside a module",
]);
/**
 * acorn's first error compiling `source` as Node compiles CommonJS (in V8's
 * place, which raises its first at the same token): at `at`, and whether V8
 * names it module syntax (an `import` or `export` where neither can be, or
 * `import.meta`). Null when it compiles. The wrapper's parameters are the top
 * scope's names (acorn's "commonjs" source type is a function body's), so a
 * lexical declaration of one is a redeclaration, through any pattern and
 * escape, as V8 finds it.
 */
function commonJsCompileError(source, scope) {
    const parser = new CommonJsBodyParser({ ecmaVersion: 'latest', sourceType: 'commonjs', allowHashBang: true }, source);
    parser.parameters = scope === 'file' ? [...COMMONJS_WRAPPER_NAMES] : [];
    try {
        parser.parse();
        return null;
    }
    catch (e) {
        const at = e.pos;
        if (!(e instanceof SyntaxError) || typeof at !== 'number')
            throw e;
        const message = e.message.replace(/ \(\d+:\d+\)$/, '');
        // V8 names an `import` not followed by `(` or `.` and an `export` its own way wherever it stands.
        const keyword = /^(?:import(?!\s*[(.])|export)(?![\w$])/.test(source.slice(at));
        return { at, esModuleSyntax: MODULE_SYNTAX_ERRORS.has(message) || (message === 'Unexpected token' && keyword) };
    }
}
/** acorn over the body of a function whose parameters are `parameters` (a CommonJS module's wrapper's). */
class CommonJsBodyParser extends StatementParser {
    parameters = [];
    parseTopLevel(node) {
        this.scopeStack[0].var.push(...this.parameters);
        return super.parseTopLevel(node);
    }
}
/**
 * Whether `source` compiles as an ES module, and V8's first error compiling
 * it as CommonJS, at `at`, is one Node retries it for. Every such error of a
 * source that compiles as a module is a redeclaration of a wrapper name or
 * an `await` read as CommonJS's identifier, whose next token V8 finds where
 * the construct around it wants another. Each of those messages is on
 * Node's list but one: V8 names an `await` whose expression a template's
 * `${}` holds, as it closes, "Missing } in template expression"
 * (templateAwaitAt).
 */
function compilesAsModuleAfter(source, at) {
    // The nodes holding `at`, innermost first: each finishes after those it holds.
    const holding = [];
    try {
        parseStatements(source, { ...MODULE_PARSE_OPTIONS, preserveParens: true }, {
            onNode: (node) => {
                if (node.start <= at && at < node.end)
                    holding.push(node);
            },
        });
    }
    catch {
        return false;
    }
    return !templateAwaitAt(holding, at);
}
/**
 * Whether the CommonJS compile's error at `at` is an `await` (read as an
 * identifier) ending the expression of a template literal's `${}`: the
 * innermost `await` before `at` holding it, up through the constructs V8
 * leaves when the operand after it cannot continue the expression (an
 * operator's either side, a sequence, a conditional's test or alternative,
 * an assignment's value), to a template literal.
 */
function templateAwaitAt(holding, at) {
    const index = holding.findIndex((node) => node.type === 'AwaitExpression' && node.start < at);
    if (index === -1)
        return false;
    let child = holding[index];
    for (const parent of holding.slice(index + 1)) {
        const continues = parent.type === 'BinaryExpression' || parent.type === 'LogicalExpression'
            || parent.type === 'SequenceExpression' || parent.type === 'UnaryExpression'
            || (parent.type === 'AssignmentExpression' && parent.right === child)
            || (parent.type === 'ConditionalExpression' && parent.consequent !== child);
        if (!continues)
            return parent.type === 'TemplateLiteral';
        child = parent;
    }
    return false;
}
/**
 * Whether `source` may hold an `await` outside every function body (a
 * top-level await), read off its tokens: true when one is found, or when the
 * source does not tokenize, so a false answer is certain.
 */
export function hasUnscopedAwait(source) {
    try {
        const tokens = tokenizer(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowHashBang: true,
        });
        const scan = unscopedAwaitScanner(source);
        for (;;) {
            const token = tokens.getToken();
            if (token.type === tokTypes.eof)
                return scan.atEnd();
            if (scan(token))
                return true;
        }
    }
    catch {
        return true;
    }
}
/**
 * The state of {@link hasUnscopedAwait}'s walk, handed `source`'s tokens in
 * order: true for the token after an `await` outside every function body
 * that is not an object key (`{ await: 135 }`, as typescript's keyword table
 * has), and `atEnd()` for one that ends the source.
 */
function unscopedAwaitScanner(source) {
    const functionBraces = [];
    const functionParenDepths = [];
    const methodParenCandidates = [];
    const arrowExpressions = [];
    let bracketDepth = 0;
    let pendingMethodBody = false;
    let pendingArrowBody = false;
    let pendingFunctionKeyword = false;
    let pendingAwait = false;
    let previous = tokTypes.eof;
    let previousEnd = 0;
    const scan = (token) => {
        const type = token.type;
        if (pendingAwait) {
            if (type !== tokTypes.colon)
                return true;
            pendingAwait = false;
        }
        if (pendingMethodBody && type !== tokTypes.braceL)
            pendingMethodBody = false;
        if (pendingArrowBody && type !== tokTypes.braceL) {
            arrowExpressions.push({
                parens: methodParenCandidates.length,
                braces: functionBraces.length,
                brackets: bracketDepth,
            });
            pendingArrowBody = false;
        }
        if (pendingFunctionKeyword) {
            if (type === tokTypes.colon || type === tokTypes.comma || type === tokTypes.braceR
                || type === tokTypes.parenR || type === tokTypes.bracketR || type === tokTypes.eq)
                functionParenDepths.pop();
            pendingFunctionKeyword = false;
        }
        if (source.slice(previousEnd, token.start).includes('\n')) {
            while (arrowExpressions.length > 0) {
                const arrow = arrowExpressions[arrowExpressions.length - 1];
                if (methodParenCandidates.length !== arrow.parens
                    || functionBraces.length !== arrow.braces
                    || bracketDepth !== arrow.brackets)
                    break;
                arrowExpressions.pop();
            }
        }
        while (arrowExpressions.length > 0) {
            const arrow = arrowExpressions[arrowExpressions.length - 1];
            const delimited = (type === tokTypes.semi || type === tokTypes.comma)
                && methodParenCandidates.length === arrow.parens
                && functionBraces.length === arrow.braces
                && bracketDepth === arrow.brackets;
            const closed = (type === tokTypes.parenR && methodParenCandidates.length === arrow.parens)
                || (type === tokTypes.bracketR && bracketDepth === arrow.brackets)
                || (type === tokTypes.braceR && functionBraces.length === arrow.braces);
            if (!delimited && !closed)
                break;
            arrowExpressions.pop();
        }
        if (type === tokTypes.name
            && previous !== tokTypes.dot && previous !== tokTypes.questionDot
            && source.slice(token.start, token.end) === 'await'
            && !functionBraces.includes(true)
            && arrowExpressions.length === 0)
            pendingAwait = true;
        if (type === tokTypes._function || type === tokTypes._class) {
            if (previous !== tokTypes.dot && previous !== tokTypes.questionDot) {
                functionParenDepths.push(methodParenCandidates.length);
                pendingFunctionKeyword = true;
            }
        }
        else if (type === tokTypes.arrow) {
            pendingArrowBody = true;
        }
        else if (type === tokTypes.parenL) {
            methodParenCandidates.push(functionBraces.length > 0
                && (previous === tokTypes.name || previous === tokTypes.string
                    || previous === tokTypes.num || previous === tokTypes.bracketR));
        }
        else if (type === tokTypes.parenR) {
            pendingMethodBody = methodParenCandidates.pop() === true;
        }
        else if (type === tokTypes.bracketL) {
            bracketDepth++;
        }
        else if (type === tokTypes.bracketR) {
            bracketDepth = Math.max(0, bracketDepth - 1);
        }
        else if (type === tokTypes.dollarBraceL) {
            functionBraces.push(false);
        }
        else if (type === tokTypes.braceL) {
            const functionBody = pendingArrowBody
                || pendingMethodBody
                || functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length;
            if (functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length) {
                functionParenDepths.pop();
            }
            functionBraces.push(functionBody);
            pendingArrowBody = false;
            pendingMethodBody = false;
        }
        else if (type === tokTypes.braceR) {
            functionBraces.pop();
        }
        previousEnd = token.end;
        previous = type;
        return false;
    };
    return Object.assign(scan, { atEnd: () => pendingAwait });
}
/**
 * Walk `source`'s tokens tracking brace, paren and bracket depth, without
 * building an AST (a multi-MiB bundle chunk must fit a 48 MiB heap). `visit`
 * sees every token with whether it sits at top level and the module syntax
 * it opens: for a top-level `import` or `export` keyword, the declaration
 * (not `import(`), and for an `import` anywhere, `import.meta`; never for a
 * member named so (after `.` or `?.`). `visit` returns true to stop the walk.
 *
 * Returns true when `visit` stopped it, false at the end of the source, and
 * null when the source does not tokenize (as `sourceType` does).
 */
export function walkTopLevelModuleTokens(source, visit, sourceType = 'module') {
    try {
        const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
        let braces = 0;
        let parens = 0;
        let brackets = 0;
        let previous = tokTypes.eof;
        // The token read past an `import` to tell its syntax, walked next.
        let ahead = null;
        for (;;) {
            const token = ahead ?? tokens.getToken();
            ahead = null;
            const type = token.type;
            if (type === tokTypes.eof)
                return false;
            const topLevel = braces === 0 && parens === 0 && brackets === 0;
            const keyword = previous !== tokTypes.dot && previous !== tokTypes.questionDot;
            previous = type;
            let syntax = null;
            if (keyword && topLevel && type === tokTypes._export) {
                syntax = 'export';
            }
            else if (keyword && type === tokTypes._import) {
                ahead = tokens.getToken();
                if (ahead.type === tokTypes.dot)
                    syntax = 'import.meta';
                else if (topLevel && ahead.type !== tokTypes.parenL)
                    syntax = 'import';
            }
            else if (type === tokTypes.braceL || type === tokTypes.dollarBraceL)
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
            if (visit(token, syntax, topLevel))
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
