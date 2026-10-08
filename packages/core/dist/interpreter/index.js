/**
 * The interpreter for code a program produces after its launch.
 *
 * A Worker compiles code only from the module map it was launched with, so
 * text handed to a Function constructor, or a module file written while the
 * program runs, cannot be compiled natively in that launch (see RUNTIME CODE
 * in _shared/commonjs-cell.ts, which records such code so the next launch
 * compiles it into its map). This runs it in the meantime, in the same realm
 * as the program: values, objects, prototypes and functions are the
 * program's own, never copies or proxies.
 *
 * The code is parsed once (acorn, bundled to reach only the built-ins the
 * launch captured at its start: parser-realm.ts), analyzed once (scope.ts)
 * and compiled once into closures (compile.ts); calling an interpreted
 * function runs those closures. host-ops.ts supplies the operators and the
 * native function objects interpreted functions are.
 *
 * Not supported, refused with UnsupportedSyntax before any of the code runs:
 * `using` declarations, TypeScript and JSX, and the bodies of `with`
 * statements in strict code (a SyntaxError anyway). A direct `eval(...)` is
 * an ordinary call of the global eval, which a Worker refuses at request time
 * natively too.
 */
import { Parser, parse, tokTypes } from 'acorn';
import { expressionFunctionBody, parseRuntimeFunction, runtimeFunctionSource, scriptExpression, } from '../_shared/runtime-function-source.js';
import { Compiler } from './compile.js';
import { moduleCell } from './modules.js';
import { ROOT_ENV, frameTemplate, installHost, isObject, makeFunction } from './runtime.js';
import { analyzeCommonJs, analyzeFunction, analyzeProgram, releaseScopes } from './scope.js';
import { ownFunctionExpression, ownProgram } from './tree.js';
import { own } from './parser-realm.js';
import { Error, LAUNCH_PRIMORDIALS, SafeMap, SyntaxError, charCodeAt, isWhitespaceCode, objectCreate, objectKeys, reflectGet, reflectGetOwnPropertyDescriptor, reflectSet, someItem, stringLastIndexOf, stringOf, stringSlice, withElement, } from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
import { programRequests } from './module-requests.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
export { replLineBody } from './repl-line.js';
/** The parameters of Node's CommonJS module wrapper. */
const WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];
/** Extensions whose text is not JavaScript acorn can parse. */
const UNPARSED_EXTENSIONS = { '.ts': true, '.mts': true, '.cts': true, '.tsx': true, '.jsx': true };
// What the parser is given inherits nothing: it reads one option directly (parser-realm.ts).
const MODULE_OPTIONS = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'module' });
const COMMONJS_OPTIONS = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', allowReturnOutsideFunction: true });
const SCRIPT_OPTIONS = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script' });
function extensionOf(path) {
    const base = stringSlice(path, stringLastIndexOf(path, '/') + 1);
    const dot = stringLastIndexOf(base, '.');
    return dot > 0 ? stringSlice(base, dot) : '';
}
/**
 * `text` without its trailing `//` comment lines (and blank lines): what
 * acorn parses. A transformer's inline source map is such a line, usually
 * most of the text (Vite's SSR modules: 3.9 of 5.2 MB in an Astro render),
 * and acorn scans a comment character by character. Dropping trailing
 * comments changes nothing a program can observe, and the cut cannot land
 * inside a string, template or block comment: those would then be
 * unterminated, the shortened text would not parse, and the caller parses
 * the whole text instead.
 */
function withoutTrailingLineComments(text) {
    let end = text.length;
    for (;;) {
        let last = end;
        while (last > 0 && isWhitespaceCode(charCodeAt(text, last - 1)))
            last--;
        const lineStart = stringLastIndexOf(text, '\n', last - 1) + 1;
        let first = lineStart;
        while (first < last && isWhitespaceCode(charCodeAt(text, first)))
            first++;
        const comment = first + 1 < last && charCodeAt(text, first) === 0x2f && charCodeAt(text, first + 1) === 0x2f;
        if (lineStart === 0 || !comment)
            return end === text.length ? text : stringSlice(text, 0, end);
        end = lineStart - 1;
    }
}
/** Parse `text` without its trailing line comments, or whole when that does not parse. */
function parseQuick(text, options) {
    const short = withoutTrailingLineComments(text);
    if (short !== text) {
        try {
            return parse(short, options);
        }
        catch {
            // The comment was not a comment; the whole text decides.
        }
    }
    return parse(text, options);
}
/** The number of '/' characters `path` starts with. */
function leadingSlashes(path) {
    let i = 0;
    while (i < path.length && charCodeAt(path, i) === 0x2f)
        i++;
    return i;
}
/**
 * The modules a file's text asks for, as this parser reads it
 * (module-requests.ts programRequests: imports, import() and require() of a
 * string, a createRequire binding's calls, and a require wrapper's). Text the
 * parser cannot read (TypeScript, JSX, a syntax error) asks for nothing. The
 * import() prefetch (node-shims.ts) finds what to fetch with it.
 */
export function moduleRequests(path, text) {
    if (UNPARSED_EXTENSIONS[extensionOf(path)])
        return [];
    let program;
    try {
        program = parseQuick(text, MODULE_OPTIONS);
    }
    catch {
        try {
            program = parseQuick(text, COMMONJS_OPTIONS);
        }
        catch {
            return [];
        }
    }
    return programRequests(program);
}
const AcornParserClass = Parser;
const FOUND = objectCreate(null);
/**
 * acorn keeping no statement once parsed, at the top level or in a block (a
 * fatal error may come from a multi-MiB bundle, and acorn's tree is 17 to 24
 * times its source): what is held is the chain of open nodes. It stops at the
 * innermost throw whose argument holds `offset`, which finishes before any
 * throw around it.
 */
class ThrowFinder extends AcornParserClass {
    offset = -1;
    found = null;
    // The token a syntax error is at, as V8 marks it: the parser's current or
    // last token where one starts there (a reserved word is raised past it).
    raisedToken = null;
    // The binding a declarator just parsed, which V8 marks where its initializer is missing.
    declared = null;
    parseVarId(decl, kind) {
        this.declared = null;
        super.parseVarId(decl, kind);
        this.declared = { start: decl.id.start, end: decl.id.end, required: kind === 'const' || decl.id.type !== 'Identifier' };
    }
    raise(pos, message) {
        const declared = this.declared;
        const missingInitializer = declared !== null && declared.required && declared.end === this.lastTokEnd
            && this.type !== tokTypes.eq && (pos === this.start || pos === this.lastTokEnd);
        this.raisedToken = missingInitializer ? [declared.start, declared.end]
            : pos === this.start ? [pos, this.end] : pos === this.lastTokStart ? [pos, this.lastTokEnd] : null;
        return super.raise(pos, message);
    }
    // acorn's is its raise, not a call of it.
    raiseRecoverable(pos, message) {
        return this.raise(pos, message);
    }
    parseTopLevel(node) {
        const exports = objectCreate(null);
        while (this.type !== tokTypes.eof)
            this.parseStatement(null, true, exports);
        if (this.inModule) {
            const names = objectKeys(this.undefinedExports);
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                const { start, end } = this.undefinedExports[name];
                this.raisedToken = [start, end];
                super.raise(start, "Export '" + name + "' is not defined");
            }
        }
        this.next();
        return this.finishNode(node, 'Program');
    }
    parseBlock(createNewLexicalScope = true, node = this.startNode(), exitStrict = false) {
        reflectSet(node, 'body', []);
        this.expect(tokTypes.braceL);
        if (createNewLexicalScope)
            this.enterScope(0);
        while (this.type !== tokTypes.braceR)
            this.parseStatement(null);
        if (exitStrict)
            this.strict = false;
        this.next();
        if (createNewLexicalScope)
            this.exitScope();
        return this.finishNode(node, 'BlockStatement');
    }
    finishNode(node, type) {
        const finished = super.finishNode(node, type);
        if (type === 'ThrowStatement') {
            const argument = reflectGet(finished, 'argument');
            if (this.offset >= reflectGet(argument, 'start') && this.offset < reflectGet(finished, 'end')) {
                const start = reflectGet(finished, 'start');
                this.found = [start, start + 1];
                throw FOUND;
            }
        }
        return finished;
    }
}
/**
 * Where V8 would place a fatal error's report in `text`, a module's whole
 * text (a `{ cjs }` cell's wrapper included) as `goal` parses it, for the
 * process's fatal report (node-shims.ts __nimbusFatalArrow), which has a
 * frame's offset and not V8's message:
 *   - `offset` given: the innermost `throw` statement whose argument holds
 *     it, as [start, start + 1], V8's location of a throw; null for none;
 *   - `offset` -1: the syntax error that stops the parse, as [start, end]
 *     of the token it stops at; null when the text parses.
 */
export function fatalLocation(text, goal, offset) {
    const finder = new ThrowFinder(goal === 'module' ? MODULE_OPTIONS : COMMONJS_OPTIONS, text);
    finder.offset = offset;
    try {
        finder.parse();
    }
    catch (error) {
        if (error === FOUND)
            return finder.found;
        if (offset !== -1 || !isObject(error))
            return null;
        const token = finder.raisedToken;
        if (token !== null && token[1] > token[0])
            return token;
        const at = reflectGet(error, 'pos');
        const end = reflectGet(error, 'raisedAt');
        if (typeof at !== 'number')
            return null;
        return [at, typeof end === 'number' && end > at ? end : at + 1];
    }
    return null;
}
/** Whether a module's top level has import or export declarations. */
function hasModuleSyntax(program) {
    return someItem(program.body, (s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration'
        || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
}
/** The interpreter's own built-ins, for the checks it shares with commonjs-cell.ts. */
const REALM = {
    SyntaxError,
    scriptOptions: own({ ecmaVersion: 'latest', sourceType: 'script' }),
    messageOf(error) {
        const message = isObject(error) ? reflectGet(error, 'message') : undefined;
        return typeof message === 'string' ? message : stringOf(error);
    },
};
let installed = null;
function unitContext(source, module, host, moduleScope) {
    return { source, module, host, imports: new SafeMap(), moduleScope };
}
/** A unit's host: `origin`'s import() and `Function` binding, or else the host's import() against `parentUrl` and the global `Function`. */
function unitHost(host, origin, parentUrl) {
    if (origin === undefined) {
        return { dynamicImport: (specifier, options) => host.dynamicImport(parentUrl, specifier, options), functionBinding: null };
    }
    // Its own property only: an origin without a Function must not take one a program put on Object.prototype.
    const own = reflectGetOwnPropertyDescriptor(origin, 'Function');
    return {
        dynamicImport: (specifier, options) => origin.import(specifier, options),
        functionBinding: own === undefined || own.value === undefined ? null : { value: own.value },
    };
}
export function createInterpreter(hostOps, host) {
    if (host.primordials !== LAUNCH_PRIMORDIALS)
        throw new Error('interpreter: its built-ins were not captured at the launch start');
    if (installed !== hostOps) {
        installHost(hostOps);
        installed = hostOps;
    }
    const interpreter = {
        compileFunction(kind, params, body, origin) {
            // A trailing source map is parsed only when the shortened body fails.
            const short = withoutTrailingLineComments(body);
            let parsed;
            try {
                parsed = parseRuntimeFunction(kind, params, short, REALM);
            }
            catch (error) {
                if (short === body)
                    throw error;
                parsed = parseRuntimeFunction(kind, params, body, REALM);
            }
            const text = parsed.text;
            const node = ownFunctionExpression(parsed.node);
            const analysis = analyzeFunction(node);
            const root = analysis.functionScopeOf(node);
            const unit = unitContext(text, false, unitHost(host, origin, undefined), null);
            const fi = new Compiler(analysis, unit, text, 0, root).rootFunction(node, 'anonymous', runtimeFunctionSource(kind, params, body));
            releaseScopes(root);
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        compileModule(path, text, origin) {
            if (UNPARSED_EXTENSIONS[extensionOf(path)])
                throw new UnsupportedSyntax(`${extensionOf(path)} source`);
            const parentUrl = stringSlice(path, 0, 5) === 'data:' ? 'data:text/javascript,' : `file:///${stringSlice(path, leadingSlashes(path))}`;
            const moduleHost = unitHost(host, origin, parentUrl);
            const compileCell = (program) => {
                const analysis = analyzeProgram(program, { kind: 'module', strict: true });
                const root = analysis.functionScopeOf(program);
                const cell = moduleCell(new Compiler(analysis, unitContext(text, true, moduleHost, root), text, 0, root).modulePlan(program, root));
                releaseScopes(root);
                return cell;
            };
            let module = null;
            try {
                module = ownProgram(parseQuick(text, MODULE_OPTIONS));
            }
            catch {
                // Not a module (sloppy-only syntax, a top-level return): CommonJS below.
            }
            if (module !== null && hasModuleSyntax(module))
                return compileCell(module);
            let script;
            try {
                script = ownProgram(parseQuick(text, COMMONJS_OPTIONS));
            }
            catch (error) {
                // Top-level await or import.meta without imports or exports: still a module.
                if (module === null)
                    throw error;
                return compileCell(module);
            }
            const analysis = analyzeCommonJs(script, WRAPPER_PARAMS);
            const root = analysis.functionScopeOf(script);
            const fi = new Compiler(analysis, unitContext(text, false, moduleHost, null), text, 0, root).commonJsFunction(script, root, WRAPPER_PARAMS);
            releaseScopes(root);
            // Called as the loader calls a staged cell, so `this` matches the next launch's.
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        compileExpression(code, origin) {
            const at = scriptExpression(code, REALM);
            if (at === null)
                throw new UnsupportedSyntax('a vm script that is not one expression');
            const body = expressionFunctionBody(stringSlice(code, 0, at.prologueEnd), stringSlice(code, at.start, at.end));
            return interpreter.compileFunction('function', [], body, origin);
        },
        runScript(text) {
            const program = ownProgram(parse(text, SCRIPT_OPTIONS));
            const analysis = analyzeProgram(program, { kind: 'script', strict: false });
            const root = analysis.functionScopeOf(program);
            const unit = unitContext(text, false, unitHost(host, undefined, undefined), null);
            const body = new Compiler(analysis, unit, text, 0, root).programBody(program, root);
            releaseScopes(root);
            if (body.g !== null)
                throw new UnsupportedSyntax('await in a script');
            body.s(withElement(frameTemplate(root.size, []), 0, ROOT_ENV));
        },
    };
    return interpreter;
}
