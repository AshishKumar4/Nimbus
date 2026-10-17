/**
 * The code `node -e` and `node -p` run, as Node prepares it
 * (lib/internal/main/eval_string.js and eval_stdin.js, v22.22.3), for a
 * process that runs it as its entry module's body.
 *
 * `-p` prints the code's completion value: the value a script evaluates to,
 * which Node gets by running the code as a script (vm runInThisContext) and
 * prints with console.log when the process exits. An entry module's body
 * has no completion value, so the code is rewritten to hand it back: every
 * statement V8 would make the script's value assigns it to a variable
 * first, and the body returns that variable. Which statements those are is
 * V8's own rewrite, ported (src/parsing/rewriter.cc Processor): walking each
 * statement list backwards, the last value-producing statement assigns; a
 * statement that may complete without a value of its own (an `if` with no
 * value in one branch, a loop, a switch, a try) assigns `undefined` first;
 * past a `break` or `continue` the statements before it count again; and a
 * `finally` keeps the value it was entered with unless it breaks.
 *
 * Code Node runs as a module (`--input-type=module`, or its syntax: the
 * caller's mode, module-format.ts isEsModuleInput) is not a script:
 * Node refuses to print it (ERR_EVAL_ESM_CANNOT_PRINT), which the code
 * becomes. Nor is code with a `return` at its top, which Node refuses to
 * compile.
 */
import { parse } from 'acorn';
import { full } from 'acorn-walk';
import { applySourceEdits, containsModuleSyntax, MODULE_PARSE_OPTIONS, parseStatements } from './javascript-ast.js';
/**
 * The entry code for `node -e <code>`, or `-p`: with `print`, a body that
 * returns the code's completion value, its `crypto` node:crypto's
 * (evalScriptSource).
 */
export function nodeEvalProgram(code, print, mode) {
    return evalProgram(evalScriptSource(code, print), print, mode);
}
/** The entry code for `node -p` reading its code from stdin (eval_stdin.js: no `crypto` wrapper). */
export function nodeStdinPrintProgram(source, mode) {
    return evalProgram(source, true, mode);
}
/**
 * `-e` code as Node's CommonJS eval takes it (eval_string.js): Node keeps
 * the identifier `crypto` its node:crypto module in eval code, for backward
 * compatibility, by wrapping code that names it (the same test, the same
 * wrappers). Its ES module branches (`--input-type=module` and
 * `module-typescript`) take the code as it is.
 */
export function evalScriptSource(code, print) {
    if (!/\bcrypto\b/.test(code))
        return code;
    return print ? `let crypto=require("node:crypto");{${code}}` : `(crypto=>{{${code}}})(require('node:crypto'))`;
}
/**
 * The entry code for eval code as Node's eval has it (evalScriptSource's,
 * or stdin's): with `print`, a body that returns its completion value.
 * A script with a `return` at its top, which the entry would run as its
 * function's (illegalReturn).
 */
export function evalProgram(code, print, mode) {
    if (mode === 'module')
        return print ? ESM_CANNOT_PRINT : { code, refusedBeforeImports: false };
    const illegal = illegalReturn(code, mode);
    if (illegal !== null)
        return illegal;
    return print ? printedProgram(code, mode) : { code, refusedBeforeImports: false };
}
/**
 * A script whose first error is a `return` at its top: V8's compile of it
 * (Node's compileScript) throws "Illegal return statement" there, where
 * the entry, the code as a function's body, would run it. The program
 * throws that SyntaxError, its arrow under the `return` (node-shims
 * __nimbusEvalIllegalReturn), before `--import`'s modules load where Node's
 * eval compiles first (`mode` 'default'). Null for any other.
 */
function illegalReturn(code, mode) {
    if (!/\breturn\b/.test(code))
        return null;
    try {
        parseStatements(code, SCRIPT, {});
        return null;
    }
    catch (e) {
        if (!(e instanceof SyntaxError) || !e.message.startsWith("'return' outside of function") || !('pos' in e) || typeof e.pos !== 'number')
            return null;
        return { code: `throw __nimbusEvalIllegalReturn(${JSON.stringify(code)}, ${e.pos});`, refusedBeforeImports: mode === 'default' };
    }
}
/** Thrown as the program's first act, after its -r preloads, as Node throws it, with no arrow of this code (Node's is its loader's). */
const ESM_CANNOT_PRINT = {
    code: 'throw __nimbusNodeError(Error, "ERR_EVAL_ESM_CANNOT_PRINT", "--print cannot be used with ESM input", undefined, null);',
    refusedBeforeImports: true,
};
/**
 * What Node runs for `-e` code or stdin (eval_string.js, eval_stdin.js),
 * `source` as given and `script` as its CommonJS branches take it
 * (evalScriptSource), by `--input-type` and, where type stripping is on
 * (`strip`), its TypeScript (execution.js):
 *   - `module`: an ES module, as it is;
 *   - `module-typescript` and `commonjs-typescript`: stripped first, then
 *     an ES module or a script; amaro's refusal is Node's error;
 *   - `commonjs`, or no input type with stripping off: a script, or an ES
 *     module by its syntax where no input type is given (evalScript);
 *   - no input type (evalTypeScript): an ES module by its syntax, compiled,
 *     else stripped; else a script, compiled, else stripped and an ES
 *     module by its stripped syntax, else a script; code amaro refuses too
 *     fails with V8's error and amaro's message (`hint`).
 * Without stripping, an input type of TypeScript names a script.
 */
export async function nodeEvalInput(source, script, inputType, strip) {
    const given = { stripped: false, stripAttempted: false };
    if (inputType === 'module')
        return { code: source, esModule: true, mode: 'module', ...given };
    if (strip !== null && (inputType === 'module-typescript' || inputType === 'commonjs-typescript')) {
        const esModule = inputType === 'module-typescript';
        const code = esModule ? source : script;
        const stripped = await strip(code);
        if ('refusal' in stripped)
            return { code, esModule: false, mode: 'commonjs', stripped: false, stripAttempted: true, refusal: stripped.refusal };
        return { code: stripped.code, esModule, mode: esModule ? 'module' : 'commonjs', stripped: true, stripAttempted: true };
    }
    if (strip === null || inputType !== undefined) {
        const esModule = inputType === undefined && containsModuleSyntax(script, 'eval');
        return { code: script, esModule, mode: esModule ? 'module' : 'commonjs', ...given };
    }
    if (containsModuleSyntax(script, 'eval'))
        return evalTypeScriptModule(script, strip);
    if (compiles(script, SCRIPT))
        return { code: script, esModule: false, mode: 'default', ...given };
    const stripped = await strip(script);
    if ('refusal' in stripped) {
        return { code: script, esModule: false, mode: 'default', stripped: false, stripAttempted: true, hint: stripped.refusal.message, refusedBeforeImports: true };
    }
    // An ES module by its syntax once stripped: compiled as one, the source again.
    if (containsModuleSyntax(stripped.code, 'eval'))
        return evalTypeScriptModule(script, strip);
    return { code: stripped.code, esModule: false, mode: 'default', stripped: true, stripAttempted: true };
}
/** evalTypeScriptModuleEntryPoint: an ES module, compiled, else stripped; one amaro refuses too fails with V8's error and its message. */
async function evalTypeScriptModule(source, strip) {
    if (compiles(source, MODULE_PARSE_OPTIONS))
        return { code: source, esModule: true, mode: 'module', stripped: false, stripAttempted: false };
    const stripped = await strip(source);
    if ('refusal' in stripped)
        return { code: source, esModule: true, mode: 'module', stripped: false, stripAttempted: true, hint: stripped.refusal.message };
    return { code: stripped.code, esModule: true, mode: 'module', stripped: true, stripAttempted: true };
}
/** Whether `source` compiles as `options` say, read in bounded memory (parseStatements): eval code may be a whole bundle on stdin. */
function compiles(source, options) {
    try {
        parseStatements(source, options, {});
        return true;
    }
    catch {
        return false;
    }
}
const SCRIPT = { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true };
function parsed(source, options) {
    try {
        return parse(source, options);
    }
    catch {
        return null;
    }
}
function printedProgram(source, mode) {
    const program = parsed(source, SCRIPT);
    // It fails to compile in the process, as it does in Node.
    if (program === null)
        return { code: source, refusedBeforeImports: mode === 'default' };
    const rewriter = new CompletionRewriter(source, freshNames(program));
    rewriter.process(program.body, 0);
    return { code: `${rewriter.apply()}\n;var ${rewriter.declared.join(',')};return ${rewriter.result};`, refusedBeforeImports: false };
}
/**
 * Names for the rewrite's variables: `base`, or `base` and a number, naming
 * no identifier of the program, as the parser decoded it (`\u005f` is `_`),
 * nor one taken before.
 */
function freshNames(program) {
    const taken = new Set();
    full(program, (node) => {
        if (node.type === 'Identifier')
            taken.add(node.name);
    });
    return (base) => {
        let name = base;
        for (let n = 1; taken.has(name); n++)
            name = `${base}${n}`;
        taken.add(name);
        return name;
    };
}
const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);
/** V8's Processor (src/parsing/rewriter.cc), over ESTree, as source insertions. */
class CompletionRewriter {
    source;
    fresh;
    /** A later statement already decides the value. */
    isSet = false;
    /** Inside a loop, a switch or a labelled statement: a `break` can leave from anywhere. */
    breakable = false;
    insertions = [];
    /** The variable holding the value. */
    result;
    /** The variables the rewritten code declares: the value's, and each finally block's saved value. */
    declared;
    constructor(source, fresh) {
        this.source = source;
        this.fresh = fresh;
        this.result = fresh('__nimbus_print_result');
        this.declared = [this.result];
    }
    apply() {
        const ordered = [...this.insertions].sort((a, b) => a.at - b.at
            || (a.close === b.close ? (a.close ? b.depth - a.depth : a.depth - b.depth) : a.close ? -1 : 1));
        const edits = ordered.map(({ at, text }) => ({ start: at, end: at, text }));
        return applySourceEdits(this.source, edits);
    }
    /** A statement list, backwards: only up to its last value, unless a `break` can skip that. A script's has no module declarations. */
    process(statements, depth) {
        for (let i = statements.length - 1; i >= 0 && (this.breakable || !this.isSet); i--) {
            this.visit(statements[i], depth);
        }
    }
    /**
     * `wrap`: what assigning `undefined` before `node` wraps, `node` itself
     * or the labels in front of it (a `continue` must still name a loop).
     */
    visit(node, depth, wrap = node) {
        switch (node.type) {
            case 'BlockStatement':
                this.process(node.body, depth + 1);
                return;
            case 'ExpressionStatement': {
                if (this.isSet)
                    return;
                const expression = node.expression;
                if (node.directive !== undefined) {
                    // A directive stays one ("use strict" decides the code's mode): its value is assigned after it.
                    this.insert(node.end, `;${this.result}=(0,${this.source.slice(expression.start, expression.end)});`, true, depth);
                }
                else {
                    // `(0, e)`: an anonymous function or class is not named after the variable.
                    this.insert(expression.start, `${this.result}=(0,`, false, depth);
                    this.insert(expression.end, ')', true, depth);
                }
                this.isSet = true;
                return;
            }
            case 'IfStatement': {
                const setAfter = this.isSet;
                this.visit(node.consequent, depth + 1);
                const setInThen = this.isSet;
                this.isSet = setAfter;
                if (node.alternate)
                    this.visit(node.alternate, depth + 1);
                if (!(setInThen && this.isSet))
                    this.undefinedBefore(wrap, depth);
                this.isSet = true;
                return;
            }
            case 'SwitchStatement':
                this.breakably(() => {
                    for (let i = node.cases.length - 1; i >= 0; i--)
                        this.process(node.cases[i].consequent, depth + 1);
                });
                this.undefinedBefore(wrap, depth);
                this.isSet = true;
                return;
            case 'TryStatement':
                this.visitTry(node, depth);
                return;
            case 'WithStatement':
                this.visit(node.body, depth + 1);
                if (!this.isSet)
                    this.undefinedBefore(wrap, depth);
                this.isSet = true;
                return;
            case 'LabeledStatement':
                this.breakably(() => this.visit(node.body, depth + 1, wrap));
                return;
            case 'BreakStatement':
            case 'ContinueStatement':
                this.isSet = false;
                return;
            case 'ThrowStatement':
                this.isSet = true;
                return;
            default:
                if (LOOPS.has(node.type)) {
                    this.breakably(() => this.visit(node.body, depth + 1));
                    this.undefinedBefore(wrap, depth);
                    this.isSet = true;
                }
            // Declarations, `;` and `debugger` have no value.
        }
    }
    /**
     * V8's TryCatchStatement and TryFinallyStatement (a try with both is a
     * try-finally around a try-catch). Assigning `undefined` before a try is
     * the try block's first statement: nothing between them can throw.
     */
    visitTry(node, depth) {
        const undefinedFirst = () => this.insert(node.block.start + 1, `${this.result}=void 0;`, false, depth);
        if (node.finalizer) {
            // A finally block's own values count only up to a break or continue out of it.
            if (this.breakable) {
                this.isSet = true;
                this.process(node.finalizer.body, depth + 1);
                if (this.isSet) {
                    // Kept and restored, in a variable of its own: the finally block
                    // does not change the value it was entered with.
                    const backup = this.fresh('__nimbus_print_backup');
                    this.declared.push(backup);
                    this.insert(node.finalizer.start + 1, `${backup}=${this.result};`, false, depth);
                    this.insert(node.finalizer.end - 1, `;${this.result}=${backup};`, true, depth);
                }
                else {
                    // It breaks or continues with no value of its own before: the
                    // try statement's value is undefined.
                    this.insert(node.finalizer.start + 1, `${this.result}=void 0;`, false, depth);
                }
                this.isSet = false;
            }
        }
        if (node.handler) {
            const setAfter = this.isSet;
            this.process(node.block.body, depth + 1);
            const setInTry = this.isSet;
            this.isSet = setAfter;
            this.process(node.handler.body.body, depth + 1);
            if (!(this.isSet && setInTry))
                undefinedFirst();
            this.isSet = true;
            if (!node.finalizer)
                return;
        }
        else {
            this.process(node.block.body, depth + 1);
        }
        if (!this.isSet)
            undefinedFirst();
        this.isSet = true;
    }
    breakably(walk) {
        const previous = this.breakable;
        this.breakable = true;
        try {
            walk();
        }
        finally {
            this.breakable = previous;
        }
    }
    /** `{ result = undefined; <wrap> }`: the statement may complete with no value of its own. */
    undefinedBefore(wrap, depth) {
        this.insert(wrap.start, `{${this.result}=void 0;`, false, depth);
        this.insert(wrap.end, '}', true, depth);
    }
    insert(at, text, close, depth) {
        this.insertions.push({ at, text, close, depth });
    }
}
