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
 * The code is parsed once (acorn), analyzed once (scope.ts) and compiled
 * once into closures (compile.ts); calling an interpreted function runs
 * those closures. host-ops.ts supplies the operators and the native function
 * objects interpreted functions are.
 *
 * Not supported, refused with UnsupportedSyntax before any of the code runs:
 * `using` declarations, TypeScript and JSX, and the bodies of `with`
 * statements in strict code (a SyntaxError anyway). A direct `eval(...)` is
 * an ordinary call of the global eval, which a Worker refuses at request time
 * natively too.
 */
import { parse } from 'acorn';
import { parseRuntimeFunction, runtimeFunctionSource } from '../_shared/runtime-function-source.js';
import { Compiler, ROOT_ENV } from './compile.js';
import { installHost, makeFunction } from './runtime.js';
import { analyzeCommonJs, analyzeFunction, analyzeProgram, releaseScopes } from './scope.js';
import { SafeMap, charCodeAt, isWhitespaceCode, someItem, stringLastIndexOf, stringSlice } from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
export { HOST_OPS_SOURCE } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
/** The parameters of Node's CommonJS module wrapper. */
const WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];
/** Extensions whose text is not JavaScript acorn can parse. */
const UNPARSED_EXTENSIONS = { '.ts': true, '.mts': true, '.cts': true, '.tsx': true, '.jsx': true };
const PARSE = { ecmaVersion: 'latest', allowHashBang: true };
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
/** Whether a module's top level has import or export declarations. */
function hasModuleSyntax(program) {
    return someItem(program.body, (s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration'
        || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
}
let installed = null;
function unitContext(source, module, host, moduleScope) {
    return { source, module, host, imports: new SafeMap(), moduleScope };
}
export function createInterpreter(hostOps, host) {
    if (installed !== hostOps) {
        installHost(hostOps);
        installed = hostOps;
    }
    return {
        compileFunction(kind, params, body) {
            // A trailing source map is parsed only when the shortened body fails.
            const short = withoutTrailingLineComments(body);
            let parsed;
            try {
                parsed = parseRuntimeFunction(kind, params, short);
            }
            catch (error) {
                if (short === body)
                    throw error;
                parsed = parseRuntimeFunction(kind, params, body);
            }
            const { node, text } = parsed;
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
            const moduleCell = (program) => {
                const analysis = analyzeProgram(program, { kind: 'module', strict: true });
                const root = analysis.functionScopeOf(program);
                const cell = new Compiler(analysis, unitContext(text, true, unitHost, root), text, 0, root).moduleCell(program, root);
                releaseScopes(root);
                return cell;
            };
            let module = null;
            try {
                module = parseQuick(text, { ...PARSE, sourceType: 'module' });
            }
            catch {
                // Not a module (sloppy-only syntax, a top-level return): CommonJS below.
            }
            if (module !== null && hasModuleSyntax(module))
                return moduleCell(module);
            let script;
            try {
                script = parseQuick(text, { ...PARSE, sourceType: 'script', allowReturnOutsideFunction: true });
            }
            catch (error) {
                // Top-level await or import.meta without imports or exports: still a module.
                if (module === null)
                    throw error;
                return moduleCell(module);
            }
            const analysis = analyzeCommonJs(script, WRAPPER_PARAMS);
            const root = analysis.functionScopeOf(script);
            const fi = new Compiler(analysis, unitContext(text, false, unitHost, null), text, 0, root).commonJsFunction(script, root, WRAPPER_PARAMS);
            releaseScopes(root);
            // Called as the loader calls a staged cell, so `this` matches the next launch's.
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        runScript(text) {
            const program = parse(text, { ...PARSE, sourceType: 'script' });
            const analysis = analyzeProgram(program, { kind: 'script', strict: false });
            const root = analysis.functionScopeOf(program);
            const unit = unitContext(text, false, { dynamicImport: (specifier, options) => host.dynamicImport(undefined, specifier, options) }, null);
            const body = new Compiler(analysis, unit, text, 0, root).programBody(program, root);
            releaseScopes(root);
            if (body.g !== null)
                throw new UnsupportedSyntax('await in a script');
            const env = new Array(root.size);
            env[0] = ROOT_ENV;
            body.s(env);
        },
    };
}
