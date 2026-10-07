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
import { parse } from 'acorn';
import { expressionFunctionBody, parseRuntimeFunction, runtimeFunctionSource, scriptExpression, } from '../_shared/runtime-function-source.js';
import { Compiler } from './compile.js';
import { moduleCell } from './modules.js';
import { ROOT_ENV, frameTemplate, installHost, isObject, makeFunction } from './runtime.js';
import { analyzeCommonJs, analyzeFunction, analyzeProgram, releaseScopes } from './scope.js';
import { ownFunctionExpression, ownProgram } from './tree.js';
import { own } from './parser-realm.js';
import { Error, LAUNCH_PRIMORDIALS, SafeMap, SyntaxError, arrayIsArray, charCodeAt, isWhitespaceCode, objectKeys, reflectGet, someItem, stringLastIndexOf, stringOf, stringSlice, withElement, } from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
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
/** A string literal, or a template with no substitutions: the specifier a request spells. */
function spelledString(node) {
    if (typeof node !== 'object' || node === null)
        return undefined;
    const type = reflectGet(node, 'type');
    if (type === 'Literal') {
        const value = reflectGet(node, 'value');
        return typeof value === 'string' ? value : undefined;
    }
    if (type !== 'TemplateLiteral')
        return undefined;
    const expressions = reflectGet(node, 'expressions');
    const quasis = reflectGet(node, 'quasis');
    if (!arrayIsArray(expressions) || expressions.length !== 0 || !arrayIsArray(quasis) || quasis.length !== 1)
        return undefined;
    const value = reflectGet(quasis[0], 'value');
    const cooked = typeof value === 'object' && value !== null ? reflectGet(value, 'cooked') : undefined;
    return typeof cooked === 'string' ? cooked : undefined;
}
/**
 * The modules a file's text asks for, as this parser reads it: import and
 * export-from sources, `import()` of a string, and `require()` of a string
 * (any call of a `require` binding, the module's own or one createRequire
 * made). A specifier spelled with escapes or in a template is read as the
 * language reads it; one in a comment or a string is not a request. Text the
 * parser cannot read (TypeScript, JSX, a syntax error) asks for nothing.
 * The import() prefetch (node-shims.ts) finds what to fetch with it.
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
    const requests = [];
    const add = (specifier, kind) => {
        if (specifier !== undefined)
            requests[requests.length] = { specifier, kind };
    };
    const pending = [program];
    while (pending.length > 0) {
        const node = pending[pending.length - 1];
        pending.length -= 1;
        if (typeof node !== 'object' || node === null)
            continue;
        if (arrayIsArray(node)) {
            for (let i = 0; i < node.length; i++)
                pending[pending.length] = node[i];
            continue;
        }
        const type = reflectGet(node, 'type');
        if (typeof type !== 'string')
            continue;
        if (type === 'ImportDeclaration' || type === 'ExportAllDeclaration' || type === 'ExportNamedDeclaration') {
            add(spelledString(reflectGet(node, 'source')), 'static');
        }
        else if (type === 'ImportExpression') {
            add(spelledString(reflectGet(node, 'source')), 'dynamic');
        }
        else if (type === 'CallExpression') {
            const callee = reflectGet(node, 'callee');
            const args = reflectGet(node, 'arguments');
            if (typeof callee === 'object' && callee !== null && reflectGet(callee, 'type') === 'Identifier'
                && reflectGet(callee, 'name') === 'require' && arrayIsArray(args) && args.length > 0) {
                add(spelledString(args[0]), 'require');
            }
        }
        const keys = objectKeys(node);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
                continue;
            // A literal's or template element's value is data; elsewhere `value` holds a node (a property's).
            if ((key === 'value' || key === 'regex') && (type === 'Literal' || type === 'TemplateElement'))
                continue;
            pending[pending.length] = reflectGet(node, key);
        }
    }
    return requests;
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
    const options = goal === 'module' ? MODULE_OPTIONS : COMMONJS_OPTIONS;
    let program;
    try {
        program = parse(text, options);
    }
    catch (error) {
        if (offset !== -1 || !isObject(error))
            return null;
        const at = reflectGet(error, 'pos');
        const end = reflectGet(error, 'raisedAt');
        if (typeof at !== 'number')
            return null;
        return [at, typeof end === 'number' && end > at ? end : at + 1];
    }
    if (offset === -1)
        return null;
    let found = null;
    const pending = [program];
    while (pending.length > 0) {
        const node = pending[pending.length - 1];
        pending.length -= 1;
        if (typeof node !== 'object' || node === null)
            continue;
        if (arrayIsArray(node)) {
            for (let i = 0; i < node.length; i++)
                pending[pending.length] = node[i];
            continue;
        }
        const start = reflectGet(node, 'start');
        const end = reflectGet(node, 'end');
        if (typeof start !== 'number' || typeof end !== 'number' || offset < start || offset >= end)
            continue;
        if (reflectGet(node, 'type') === 'ThrowStatement') {
            const argument = reflectGet(node, 'argument');
            const from = isObject(argument) ? reflectGet(argument, 'start') : undefined;
            if (typeof from === 'number' && offset >= from)
                found = [start, start + 1];
        }
        const keys = objectKeys(node);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key !== 'type' && key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range')
                pending[pending.length] = reflectGet(node, key);
        }
    }
    return found;
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
export function createInterpreter(hostOps, host) {
    if (host.primordials !== LAUNCH_PRIMORDIALS)
        throw new Error('interpreter: its built-ins were not captured at the launch start');
    if (installed !== hostOps) {
        installHost(hostOps);
        installed = hostOps;
    }
    const interpreter = {
        compileFunction(kind, params, body) {
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
            const unit = unitContext(text, false, { dynamicImport: (specifier, options) => host.dynamicImport(undefined, specifier, options) }, null);
            const fi = new Compiler(analysis, unit, text, 0, root).rootFunction(node, 'anonymous', runtimeFunctionSource(kind, params, body));
            releaseScopes(root);
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        compileModule(path, text) {
            if (UNPARSED_EXTENSIONS[extensionOf(path)])
                throw new UnsupportedSyntax(`${extensionOf(path)} source`);
            const parentUrl = stringSlice(path, 0, 5) === 'data:' ? 'data:text/javascript,' : `file:///${stringSlice(path, leadingSlashes(path))}`;
            const unitHost = { dynamicImport: (specifier, options) => host.dynamicImport(parentUrl, specifier, options) };
            const compileCell = (program) => {
                const analysis = analyzeProgram(program, { kind: 'module', strict: true });
                const root = analysis.functionScopeOf(program);
                const cell = moduleCell(new Compiler(analysis, unitContext(text, true, unitHost, root), text, 0, root).modulePlan(program, root));
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
            const fi = new Compiler(analysis, unitContext(text, false, unitHost, null), text, 0, root).commonJsFunction(script, root, WRAPPER_PARAMS);
            releaseScopes(root);
            // Called as the loader calls a staged cell, so `this` matches the next launch's.
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        compileExpression(code) {
            const at = scriptExpression(code, REALM);
            if (at === null)
                throw new UnsupportedSyntax('a vm script that is not one expression');
            const body = expressionFunctionBody(stringSlice(code, 0, at.prologueEnd), stringSlice(code, at.start, at.end));
            return interpreter.compileFunction('function', [], body);
        },
        runScript(text) {
            const program = ownProgram(parse(text, SCRIPT_OPTIONS));
            const analysis = analyzeProgram(program, { kind: 'script', strict: false });
            const root = analysis.functionScopeOf(program);
            const unit = unitContext(text, false, { dynamicImport: (specifier, options) => host.dynamicImport(undefined, specifier, options) }, null);
            const body = new Compiler(analysis, unit, text, 0, root).programBody(program, root);
            releaseScopes(root);
            if (body.g !== null)
                throw new UnsupportedSyntax('await in a script');
            body.s(withElement(frameTemplate(root.size, []), 0, ROOT_ENV));
        },
    };
    return interpreter;
}
