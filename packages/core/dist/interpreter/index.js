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
import { FunctionScope, analyzeCommonJs, analyzeFunction, analyzeProgram } from './scope.js';
import { UnsupportedSyntax } from './unsupported.js';
export { HOST_OPS_SOURCE } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
/** The parameters of Node's CommonJS module wrapper. */
const WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];
/** Extensions whose text is not JavaScript acorn can parse. */
const UNPARSED_EXTENSIONS = { '.ts': true, '.mts': true, '.cts': true, '.tsx': true, '.jsx': true };
const PARSE = { ecmaVersion: 'latest', allowHashBang: true };
function extensionOf(path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot) : '';
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
        while (last > 0 && /\s/.test(text[last - 1]))
            last--;
        const lineStart = text.lastIndexOf('\n', last - 1) + 1;
        if (lineStart === 0 || !text.slice(lineStart, last).trimStart().startsWith('//'))
            return end === text.length ? text : text.slice(0, end);
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
/** Whether a module's top level has import or export declarations. */
function hasModuleSyntax(program) {
    return program.body.some((s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration'
        || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
}
let installed = null;
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
            const compiler = new Compiler(analysis, text, { dynamicImport: (specifier, options) => host.dynamicImport(undefined, specifier, options) }, root);
            const fi = compiler.functionInfo(node, 'anonymous', undefined, runtimeFunctionSource(kind, params, body));
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        compileModule(path, text) {
            if (UNPARSED_EXTENSIONS[extensionOf(path)])
                throw new UnsupportedSyntax(`${extensionOf(path)} source`);
            const parentUrl = path.startsWith('data:') ? 'data:text/javascript,' : `file:///${path.replace(/^\/+/, '')}`;
            const unitHost = { dynamicImport: (specifier, options) => host.dynamicImport(parentUrl, specifier, options) };
            let module = null;
            try {
                module = parseQuick(text, { ...PARSE, sourceType: 'module' });
            }
            catch {
                // Not a module (sloppy-only syntax, a top-level return): CommonJS below.
            }
            if (module !== null && hasModuleSyntax(module)) {
                const analysis = analyzeProgram(module, { kind: 'module', strict: true });
                const root = analysis.functionScopeOf(module);
                return new Compiler(analysis, text, unitHost, root).moduleCell(module, root);
            }
            let script;
            try {
                script = parseQuick(text, { ...PARSE, sourceType: 'script', allowReturnOutsideFunction: true });
            }
            catch (error) {
                // Top-level await or import.meta without imports or exports: still a module.
                if (module === null)
                    throw error;
                const analysis = analyzeProgram(module, { kind: 'module', strict: true });
                const root = analysis.functionScopeOf(module);
                return new Compiler(analysis, text, unitHost, root).moduleCell(module, root);
            }
            const analysis = analyzeCommonJs(script, WRAPPER_PARAMS);
            const root = analysis.functionScopeOf(script);
            const fi = new Compiler(analysis, text, unitHost, root).commonJsFunction(script, root, WRAPPER_PARAMS);
            // Called as the loader calls a staged cell, so `this` matches the next launch's.
            return makeFunction(fi, ROOT_ENV, undefined);
        },
        runScript(text) {
            const program = parse(text, { ...PARSE, sourceType: 'script' });
            const analysis = analyzeProgram(program, { kind: 'script', strict: false });
            const root = analysis.functionScopeOf(program);
            if (!(root instanceof FunctionScope))
                throw new Error('interpreter: script without a scope');
            const body = new Compiler(analysis, text, { dynamicImport: (specifier, options) => host.dynamicImport(undefined, specifier, options) }, root)
                .programBody(program, root);
            if (body.g !== null)
                throw new UnsupportedSyntax('await in a script');
            const env = new Array(root.size);
            env[0] = ROOT_ENV;
            body.s(env);
        },
    };
}
