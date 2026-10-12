/**
 * esm-require-hoist.ts — which require() calls of an ES module's top level
 * the registry can evaluate natively, and the question that decides the rest:
 * does a module await at its top level.
 *
 * A require() of an ES module (Node 22's require(esm)) evaluates its graph
 * synchronously, at the call. The registry cannot: it runs a module body
 * only from its gate (native-esm.ts), after the import that links it, so a
 * graph a require() meets unevaluated is the interpreter's (node-shims'
 * adoption), at a cost a whole application cannot pay. One shape is common
 * and needs no such evaluation: a module whose top level loads the program
 * through require() before anything else happens (pi's bin:
 * `enableCompileCache(); createRequire(import.meta.url)("./cli-runtime.js")`).
 * There the require() can be the module's last static import instead, and
 * the target is evaluated where Node evaluates it, as far as anything can
 * tell: after the module's own imports, before any statement of its body
 * that could observe the target or be observed by it. So a require() is
 * hoisted only when every top-level statement before it is one of:
 *   - an import or export-from declaration (evaluated first in either order);
 *   - a function declaration, or a class declaration that runs no code when
 *     declared (no heritage: `extends undefined`, or a name in its TDZ,
 *     throws; no static block, computed key, or static field initializer but
 *     a literal);
 *   - a const, let or var that binds names (no pattern) to literals, a
 *     createRequire(import.meta.url) call (pure: a function of the module's
 *     URL), or an earlier hoisted require() (both orders evaluate the two
 *     targets in turn). A pattern runs code after its initializer: getters
 *     (inherited ones, an export named 'module.exports'), an iterator,
 *     defaults, computed keys, a throw on null. Its declarator's require()
 *     is hoisted, and it ends the prefix;
 *   - a directive, an empty statement, or a call of module.enableCompileCache.
 *     That one has no effect a module can observe in Nimbus, which keeps no
 *     compile cache (the guest's answers DISABLED, status 3, the same before
 *     the target and after it).
 * and the require() is its statement's whole effect: a statement of its own,
 * or a declarator's initializer, with a literal specifier, through a name
 * bound to createRequire(import.meta.url) at the top level or the call itself.
 * Anything else ends the prefix, and later requires are left to the call.
 * The target's graph must not contain the module and must not await at its
 * top level (staging checks both: worker facets/esm-stage.ts); otherwise
 * Node's own refusal is the call's to throw.
 */
import { MODULE_PARSE_OPTIONS, parseStatements } from './javascript-ast.js';
/** A top-level statement past which no require() is hoisted. */
const PREFIX_END = Symbol('prefix end');
/** The module specifiers createRequire and enableCompileCache come from. */
const NODE_MODULE = { 'node:module': true, module: true };
function isImportMetaUrl(node) {
    return node.type === 'MemberExpression' && !node.computed && node.object.type === 'MetaProperty'
        && node.object.meta.name === 'import' && node.property.type === 'Identifier' && node.property.name === 'url';
}
function isLiteral(node) {
    if (node === null || node === undefined)
        return true;
    if (node.type === 'Literal')
        return true;
    if (node.type === 'TemplateLiteral')
        return node.expressions.length === 0;
    if (node.type === 'UnaryExpression')
        return (node.operator === '-' || node.operator === '+' || node.operator === '!') && node.argument.type === 'Literal';
    return false;
}
/**
 * The literal specifiers of the require() calls at `code`'s top level that
 * can be hoisted to static imports, in order (see the header). `code` is an
 * ES module's text; one that does not parse has none.
 */
export function hoistableRequires(code) {
    if (!code.includes('createRequire'))
        return [];
    const createRequires = new Set();
    const moduleNamespaces = new Set();
    const compileCaches = new Set();
    const requires = new Set();
    const found = [];
    /** `node` is a call of the module's createRequire with its URL. */
    const isCreateRequire = (node) => {
        if (node.type !== 'CallExpression' || node.arguments.length !== 1 || !isImportMetaUrl(node.arguments[0]))
            return false;
        const callee = node.callee;
        if (callee.type === 'Identifier')
            return createRequires.has(callee.name);
        return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier'
            && moduleNamespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'createRequire';
    };
    /** The specifier of a require() of a literal through the module's createRequire, or null. */
    const requireOf = (node) => {
        if (node.type !== 'CallExpression' || node.arguments.length !== 1)
            return null;
        const argument = node.arguments[0];
        if (argument.type !== 'Literal' || typeof argument.value !== 'string')
            return null;
        const callee = node.callee;
        if ((callee.type === 'Identifier' && requires.has(callee.name)) || isCreateRequire(callee))
            return argument.value;
        return null;
    };
    const isCompileCache = (node) => {
        if (node.type !== 'CallExpression')
            return false;
        if (!node.arguments.every((argument) => isLiteral(argument)))
            return false;
        const callee = node.callee;
        if (callee.type === 'Identifier')
            return compileCaches.has(callee.name);
        return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier'
            && moduleNamespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'enableCompileCache';
    };
    const quietClass = (node) => {
        if (node.type !== 'ClassDeclaration' || node.superClass)
            return false;
        return node.body.body.every((member) => {
            if (member.type === 'StaticBlock')
                return false;
            if (member.computed)
                return false;
            if (member.type === 'PropertyDefinition' && member.static)
                return isLiteral(member.value);
            return true;
        });
    };
    /** Whether a top-level statement may come before a hoisted require(); records what it binds. */
    const quiet = (statement) => {
        switch (statement.type) {
            case 'ImportDeclaration': {
                const source = String(statement.source.value);
                for (const specifier of statement.specifiers) {
                    if (!NODE_MODULE[source])
                        continue;
                    if (specifier.type === 'ImportSpecifier') {
                        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
                        if (imported === 'createRequire')
                            createRequires.add(specifier.local.name);
                        else if (imported === 'enableCompileCache')
                            compileCaches.add(specifier.local.name);
                    }
                    else {
                        moduleNamespaces.add(specifier.local.name);
                    }
                }
                return true;
            }
            case 'ExportAllDeclaration': return true;
            case 'ExportNamedDeclaration': return statement.declaration ? quiet(statement.declaration) : true;
            case 'EmptyStatement':
            case 'FunctionDeclaration': return true;
            case 'ClassDeclaration': return quietClass(statement);
            case 'VariableDeclaration': {
                for (const declarator of statement.declarations) {
                    const init = declarator.init;
                    if (init && isCreateRequire(init)) {
                        if (declarator.id.type === 'Identifier')
                            requires.add(declarator.id.name);
                    }
                    else if (!isLiteral(init)) {
                        const specifier = init ? requireOf(init) : null;
                        if (specifier === null)
                            return false;
                        found.push(specifier);
                    }
                    if (declarator.id.type !== 'Identifier')
                        return false;
                }
                return true;
            }
            case 'ExpressionStatement': {
                const expression = statement.expression;
                if (expression.type === 'Literal')
                    return true;
                if (isCompileCache(expression))
                    return true;
                const specifier = requireOf(expression);
                if (specifier === null)
                    return false;
                found.push(specifier);
                return true;
            }
            default: return false;
        }
    };
    try {
        parseStatements(code, MODULE_PARSE_OPTIONS, {
            onStatement: (statement) => {
                if (!quiet(statement))
                    throw PREFIX_END;
            },
        });
    }
    catch (error) {
        // A text acorn cannot read (or nests past its stack) has no hoist past what was read.
        if (error !== PREFIX_END && !(error instanceof SyntaxError) && !(error instanceof RangeError))
            throw error;
    }
    return found;
}
/**
 * Whether an ES module's text awaits at its top level (an `await`, or a
 * `for await`, outside every function): V8's [[HasTLA]], which Node's
 * require() refuses a graph for. Text acorn cannot read (one that does not
 * parse, which the registry reports, or nests past its stack) has none. Nodes
 * complete inner first, so a function drops the awaits it holds as it
 * completes, and what is left is the top level's.
 */
export function hasTopLevelAwait(code) {
    if (!code.includes('await'))
        return false;
    const awaits = [];
    try {
        parseStatements(code, MODULE_PARSE_OPTIONS, {
            onNode(node) {
                if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await))
                    awaits.push(node.start);
                else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
                    while (awaits.length > 0 && awaits[awaits.length - 1] >= node.start)
                        awaits.pop();
                }
            },
        });
    }
    catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof RangeError))
            throw error;
        return false;
    }
    return awaits.length > 0;
}
/** An ES module's EsModuleFacts. */
export function esModuleFacts(code) {
    const requires = hoistableRequires(code);
    return {
        ...(hasTopLevelAwait(code) ? { topLevelAwait: true } : {}),
        ...(requires.length > 0 ? { requires } : {}),
    };
}
