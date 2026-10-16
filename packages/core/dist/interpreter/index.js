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
 * The code is parsed once (acorn, the parser module beside the interpreter,
 * which reaches only the built-ins the launch captured at its start:
 * parser.ts, parser-realm.ts), analyzed once (scope.ts)
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
import { parse } from 'acorn';
import { expressionFunctionBody, parseRuntimeFunction, runtimeFunctionSource, scriptExpression, } from '../_shared/runtime-function-source.js';
import { Compiler, programBindings } from './compile.js';
import { moduleCell, moduleLink, moduleLinkRequests } from './modules.js';
import { InterpreterRuntime, ROOT_ENV, frameTemplate, isObject } from './runtime.js';
import { analyzeCommonJs, analyzeFunction, analyzeProgram, releaseScopes } from './scope.js';
import { ownFunctionExpression, ownProgram } from './tree.js';
import { own } from './parser-realm.js';
import { Error, LAUNCH_PRIMORDIALS, SafeMap, SafeWeakSet, SyntaxError, append, charCodeAt, contains, isWhitespaceCode, newSafeList, reflectGet, reflectGetOwnPropertyDescriptor, someItem, stringLastIndexOf, stringOf, stringSlice, withElement, } from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
import { programRequests } from './module-requests.js';
import { bindingIdentifiers } from '../runtime/binding-pattern.js';
import { importerUrl } from '../_shared/importer-url.js';
import { stampStack, stackFrames } from './stack.js';
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
/**
 * The modules a file's text asks for, as this parser reads it
 * (module-requests.ts programRequests: imports, import() and require() of a
 * string, a createRequire binding's calls, and a require wrapper's), or why
 * it read none: the text does not parse ('syntax'), or is TypeScript or JSX,
 * which it does not read ('unparsed'). The import() prefetch (node-shims.ts)
 * finds what to fetch with the requests, reading what it can; a late
 * graph's link plan reads with the loader's parse goal (`goal`: the format
 * the loader gives the module, or 'detect' where its syntax decides, as
 * compileModule parses it), and loads a module it could not read as the
 * interpreter does, for its error. `javaScript`: the text is JavaScript
 * whatever the path's extension (a staged module's, as compileModule's).
 */
export function moduleRequests(path, text, javaScript = false, goal) {
    if (!javaScript && UNPARSED_EXTENSIONS[extensionOf(path)])
        return { requests: [], unread: 'unparsed' };
    if (goal !== undefined) {
        try {
            const { module, program } = formatProgram(text, goal === 'detect' ? undefined : goal);
            return { requests: programRequests(program), ...(module ? { bindings: programBindings(program) } : {}) };
        }
        catch {
            return { requests: [], unread: 'syntax' };
        }
    }
    let program;
    try {
        program = parseQuick(text, MODULE_OPTIONS);
    }
    catch {
        try {
            program = parseQuick(text, COMMONJS_OPTIONS);
        }
        catch {
            return { requests: [], unread: 'syntax' };
        }
    }
    return { requests: programRequests(program) };
}
/**
 * The wrapper parameter a top-level lexical declaration of `program`
 * redeclares, or null: V8 compiles CommonJS in Node's wrapper, and refuses
 * one ("Identifier 'require' has already been declared").
 */
function redeclaredWrapperParameter(program) {
    for (let i = 0; i < program.body.length; i++) {
        const statement = program.body[i];
        const names = newSafeList();
        if (statement.type === 'ClassDeclaration' && statement.id !== null)
            append(names, statement.id);
        else if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
            for (let d = 0; d < statement.declarations.length; d++)
                bindingIdentifiers(statement.declarations[d].id, names);
        }
        for (let n = 0; n < names.length; n++) {
            if (contains(WRAPPER_PARAMS, names[n].name))
                return names[n].name;
        }
    }
    return null;
}
/** Whether a module's top level has import or export declarations. */
function hasModuleSyntax(program) {
    return someItem(program.body, (s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration'
        || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
}
/**
 * A module file's text as Node detects its format: an ES module when it has
 * import or export declarations, or when it parses only as one (top-level
 * await, import.meta); else CommonJS, a script whose top level may return.
 */
function moduleProgram(text, format) {
    const { module, program } = formatProgram(text, format);
    return { module, program: ownProgram(program) };
}
/**
 * What text is in the loader's format, and its program: `format` where the
 * loader gives one, else its syntax decides (Node's detection), as
 * compileModule parses it; throws what the parse throws.
 */
function formatProgram(text, format) {
    if (format === 'module')
        return { module: true, program: parseQuick(text, MODULE_OPTIONS) };
    if (format === 'commonjs')
        return { module: false, program: commonJsProgram(text) };
    let module = null;
    try {
        module = parseQuick(text, MODULE_OPTIONS);
    }
    catch {
        // Not a module (sloppy-only syntax, a top-level return): CommonJS below.
    }
    if (module !== null && hasModuleSyntax(module))
        return { module: true, program: module };
    try {
        return { module: false, program: commonJsProgram(text) };
    }
    catch (error) {
        // What V8 refuses only as CommonJS (Node's throwsOnlyInCommonJSErrorMessages) is a module where it is one.
        if (module === null)
            throw error;
        return { module: true, program: module };
    }
}
/** `text` as V8 compiles CommonJS: a script whose top level may return, in a wrapper whose parameters it may not redeclare. */
function commonJsProgram(text) {
    const program = parseQuick(text, COMMONJS_OPTIONS);
    const redeclared = redeclaredWrapperParameter(program);
    if (redeclared !== null)
        throw new SyntaxError(`Identifier '${redeclared}' has already been declared`);
    return program;
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
function unitContext(runtime, source, module, host, moduleScope, stack) {
    return { source, module, host, runtime, imports: new SafeMap(), moduleScope, stack };
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
    const runtime = new InterpreterRuntime(hostOps);
    const capture = reflectGetOwnPropertyDescriptor(host, 'stackCapture')?.value;
    const isProxy = reflectGetOwnPropertyDescriptor(host, 'stackIsProxy')?.value;
    const isError = reflectGetOwnPropertyDescriptor(host, 'stackIsError')?.value;
    const stackUnit = (source, file, esModule) => ({
        source, file, esModule, capture: typeof capture === 'function' ? capture : null,
        isProxy: typeof isProxy === 'function' ? isProxy : null,
        isError: typeof isError === 'function' ? isError : null,
    });
    const detected = new SafeWeakSet();
    const awaiting = new SafeWeakSet();
    const interpreter = {
        captureStack(error, above) { stampStack(error, undefined, above, true); },
        stackFrames,
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
            const unit = unitContext(runtime, text, false, unitHost(host, origin, undefined), null, stackUnit(text, null, false));
            const fi = new Compiler(analysis, unit, text, 0, root).rootFunction(node, 'anonymous', runtimeFunctionSource(kind, params, body));
            releaseScopes(root);
            return runtime.makeFunction(fi, ROOT_ENV, undefined);
        },
        compileModule(path, text, origin, javaScript = false, format) {
            if (!javaScript && UNPARSED_EXTENSIONS[extensionOf(path)])
                throw new UnsupportedSyntax(`${extensionOf(path)} source`);
            const parentUrl = importerUrl(path, charCodeAt);
            const stackFile = charCodeAt(path, 0) === 47 || stringSlice(path, 0, 5) === 'data:' || stringSlice(path, 0, 5) === 'file:' ? path : '/' + path;
            const moduleHost = unitHost(host, origin, parentUrl);
            const parsed = moduleProgram(text, format);
            if (parsed.module) {
                const program = parsed.program;
                const analysis = analyzeProgram(program, { kind: 'module', strict: true });
                const root = analysis.functionScopeOf(program);
                const plan = new Compiler(analysis, unitContext(runtime, text, true, moduleHost, root, stackUnit(text, stackFile, true)), text, 0, root).modulePlan(program, root);
                releaseScopes(root);
                const cell = moduleCell(plan, runtime.ops, host.moduleHelpers);
                if (format === undefined)
                    detected.add(cell);
                if (plan.body.g !== null)
                    awaiting.add(cell);
                return cell;
            }
            const script = parsed.program;
            const analysis = analyzeCommonJs(script, WRAPPER_PARAMS);
            const root = analysis.functionScopeOf(script);
            const fi = new Compiler(analysis, unitContext(runtime, text, false, moduleHost, null, stackUnit(text, stackFile, false)), text, 0, root).commonJsFunction(script, root, WRAPPER_PARAMS);
            releaseScopes(root);
            // Called as the loader calls a staged cell, so `this` matches the next launch's.
            return runtime.makeFunction(fi, ROOT_ENV, undefined);
        },
        detectedModule(cell) {
            return typeof cell === 'function' && detected.has(cell);
        },
        moduleAwaits(cell) {
            return typeof cell === 'function' && awaiting.has(cell);
        },
        moduleLink(cell) {
            return moduleLink(cell);
        },
        moduleLinkRequests(cell) {
            return moduleLinkRequests(cell);
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
            const unit = unitContext(runtime, text, false, unitHost(host, undefined, undefined), null, stackUnit(text, null, false));
            const body = new Compiler(analysis, unit, text, 0, root).programBody(program, root);
            releaseScopes(root);
            if (body.g !== null)
                throw new UnsupportedSyntax('await in a script');
            body.s(withElement(frameTemplate(root.size, []), 0, ROOT_ENV));
        },
    };
    return interpreter;
}
