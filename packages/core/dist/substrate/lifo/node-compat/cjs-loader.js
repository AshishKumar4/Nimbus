import { createModuleMap, ProcessExitError } from './index.js';
import { createModuleShim } from './module.js';
import { Buffer } from './buffer.js';
import { emitCommonJs, readEsmRecords } from '../../../runtime/async-module-lowering.js';
import { applySourceEdits, forEachNode, hasTopLevelModuleSyntax, parseJavaScriptModule } from '../../../runtime/javascript-ast.js';
import { fileURLToPath } from './url.js';
import { resolve, dirname, join, extname } from '../utils/path.js';
/** Node's error for a module `require` cannot find: its message and its code. */
export function moduleNotFound(name) {
    return Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
}
/** Strip a shebang line (`#!/usr/bin/env node`), leaving a blank line so line numbers hold. */
export function stripShebang(src) {
    if (src.charCodeAt(0) === 0x23 /* # */ && src.charCodeAt(1) === 0x21 /* ! */) {
        const nl = src.indexOf('\n');
        if (nl === -1)
            return '';
        return '\n' + src.slice(nl + 1);
    }
    return src;
}
/** The `import.meta` and dynamic `import()` expressions of module `source`, as acorn parses it. */
function moduleOnlyExpressions(source) {
    const found = { meta: [], dynamic: [] };
    // Neither can occur without the keyword followed by `.` or `(`: a module without one needs no second parse.
    if (!/\bimport\s*[.(]/.test(source))
        return found;
    forEachNode(parseJavaScriptModule(source), (node) => {
        if (node.type === 'MetaProperty' && node.meta.name === 'import')
            found.meta.push(node);
        else if (node.type === 'ImportExpression')
            found.dynamic.push(node);
    });
    return found;
}
/**
 * Whether `source` is an ES module by its syntax, as Node's detection reads
 * it: a top-level import or export declaration (not `import(`, not one
 * inside a string), or an `import.meta`.
 */
export function isEsmSource(source) {
    if (hasTopLevelModuleSyntax(source))
        return true;
    if (!source.includes('import.meta'))
        return false;
    try {
        return moduleOnlyExpressions(source).meta.length > 0;
    }
    catch {
        return false;
    }
}
/** A package.json's "type", when it declares one. */
export function declaredPackageType(packageJson) {
    try {
        const pkg = JSON.parse(packageJson);
        const type = typeof pkg === 'object' && pkg !== null && 'type' in pkg ? pkg.type : undefined;
        return type === 'module' || type === 'commonjs' ? type : null;
    }
    catch {
        return null;
    }
}
/** Nearest package.json "type" walking up from a .js file (Node.js semantics), read synchronously inside `require`. */
function packageType(filename, vfs) {
    for (let dir = dirname(filename);; dir = dirname(dir)) {
        const pkgPath = join(dir, 'package.json');
        if (vfs.exists(pkgPath))
            return declaredPackageType(vfs.readFileString(pkgPath));
        if (dirname(dir) === dir)
            return null;
    }
}
/** Whether a module runs as an ES module: .mjs always, .cjs never, a .js by its package's type, else by its syntax. */
export function treatAsEsm(source, filename, declared) {
    const ext = extname(filename);
    if (ext === '.mjs')
        return true;
    if (ext === '.cjs')
        return false;
    const type = ext === '.js' ? declared() : null;
    return type === null ? isEsmSource(source) : type === 'module';
}
// The wrapper every module runs in: CommonJS's five names, the globals a
// module may find as free variables, and for a lowered ES module its
// import.meta, its dynamic import, and the require and module the lowering's
// own lines use (names the module's bindings cannot shadow: a module may
// declare its own `require` with createRequire).
const WRAPPER_PARAMS = 'exports, require, module, __filename, __dirname, console, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, global, __importMeta, __importDynamic, __nimbusRequire, __nimbusModule';
/**
 * ES module `source` as the CommonJS the module wrapper runs: its import.meta
 * the wrapper's __importMeta, its import() the wrapper's __importDynamic, and
 * its declarations through the shared emitter (async-module-lowering.ts). The
 * whole is one block, so the module's own bindings (`const __dirname`, `import
 * process from`) shadow the wrapper's parameters as module scope does.
 */
function lowerModule(source) {
    const { meta, dynamic } = moduleOnlyExpressions(source);
    const rewritten = applySourceEdits(source, [
        ...meta.map((node) => ({ start: node.start, end: node.end, text: '__importMeta' })),
        ...dynamic.map((node) => ({ start: node.start, end: node.start + 'import'.length, text: '__importDynamic' })),
    ]);
    const lowered = emitCommonJs(rewritten, readEsmRecords(rewritten), {
        body: 'sync',
        requireFunction: '__nimbusRequire',
        exportsObject: '__nimbusModule.exports',
    });
    return `{\n${lowered}\n}`;
}
/** `source`, ESM lowered when `esm`, as the module wrapper's function text. Throws a SyntaxError for an ES module that does not parse. */
export function moduleWrapper(source, esm, async = false) {
    const body = esm ? `"use strict";\n${lowerModule(source)}` : `\n${source}`;
    return `(${async ? 'async ' : ''}function(${WRAPPER_PARAMS}) {${body}\n})`;
}
// @rollup/rollup-* are platform-specific NAPI addons, which no realm here can
// load. Vite's dev server uses es-module-lexer, not rollup's parser, so these
// may never be called; if they are, the hashes return stable stand-ins and
// the parsers throw.
function stubHash(radix) {
    return (data) => {
        const s = typeof data === 'string' ? data : String(data);
        let h = 0;
        for (let i = 0; i < s.length; i++)
            h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(radix);
    };
}
const rollupNativeStub = {
    parse: () => { throw new Error('[lifo] rollup native parser is not available in browser'); },
    parseAsync: () => Promise.reject(new Error('[lifo] rollup native parser is not available in browser')),
    xxhashBase64Url: stubHash(36),
    xxhashBase36: stubHash(36),
    xxhashBase16: stubHash(16),
};
/**
 * A loader over `context`'s filesystem. `scope` gives each module its
 * console and process (each module has its own, as the node command's
 * modules always have had).
 */
export function createCjsLoader(context, scope) {
    const filesystem = context.filesystem;
    const moduleMap = createModuleMap(context);
    const builtins = new Map();
    const cache = Object.create(null);
    // createRequire(filename) is require as a module at `filename` has it: a path, or a file: URL's decoded path.
    moduleMap.module = () => createModuleShim(moduleMap, (filename) => {
        const path = filename instanceof URL || String(filename).startsWith('file:') ? fileURLToPath(filename) : String(filename);
        return requireFrom(dirname(path));
    });
    function requireFrom(dir) {
        const req = ((id) => requireModule(id, dir));
        req.resolve = (id) => {
            const name = id.startsWith('node:') ? id.slice(5) : id;
            if (moduleMap[name])
                return name;
            const path = resolveFilename(name, dir);
            if (path === null)
                throw moduleNotFound(id);
            return path;
        };
        req.cache = cache;
        return req;
    }
    function requireModule(id, dir) {
        const name = id.startsWith('node:') ? id.slice(5) : id;
        if (moduleMap[name]) {
            if (!builtins.has(name))
                builtins.set(name, moduleMap[name]());
            return builtins.get(name);
        }
        const path = resolveFilename(name, dir);
        if (path !== null)
            return load(path);
        if (name.startsWith('@rollup/rollup-'))
            return rollupNativeStub;
        throw moduleNotFound(name);
    }
    function resolveFilename(name, dir) {
        if (name.startsWith('#'))
            return resolvePackageImport(name, dir);
        if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/'))
            return resolveFile(name, dir);
        return resolveNodeModule(name, dir);
    }
    function resolveFile(name, fromDir) {
        const absPath = resolve(fromDir, name);
        if (filesystem().exists(absPath)) {
            try {
                if (filesystem().stat(absPath).type === 'file')
                    return absPath;
                const indexPath = join(absPath, 'index.js');
                if (filesystem().exists(indexPath))
                    return indexPath;
            }
            catch { /* fall through */ }
        }
        if (!extname(absPath)) {
            for (const ext of ['.js', '.mjs', '.json']) {
                if (filesystem().exists(absPath + ext))
                    return absPath + ext;
            }
        }
        return null;
    }
    /** A `#` name from the nearest package.json's "imports", as Node reads it (the nearest package.json wins). */
    function resolvePackageImport(name, fromDir) {
        for (let current = fromDir;; current = dirname(current)) {
            const pkgPath = join(current, 'package.json');
            if (filesystem().exists(pkgPath)) {
                try {
                    const pkg = JSON.parse(filesystem().readFileString(pkgPath));
                    if (pkg.imports && typeof pkg.imports === 'object' && name in pkg.imports) {
                        const target = resolveExportsCondition(pkg.imports[name]);
                        if (target)
                            return resolveFile(target, current);
                    }
                }
                catch { /* ignore parse errors */ }
                return null;
            }
            if (dirname(current) === current)
                return null;
        }
    }
    function resolveNodeModule(name, fromDir) {
        const parts = name.split('/');
        const scoped = name.startsWith('@');
        if (scoped && parts.length < 2)
            return null;
        const packageName = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
        const rest = parts.slice(scoped ? 2 : 1);
        const subpath = rest.length > 0 ? rest.join('/') : null;
        for (let current = fromDir;; current = dirname(current)) {
            const candidate = join(current, 'node_modules', packageName);
            if (filesystem().exists(candidate)) {
                const resolved = resolvePackageEntry(candidate, subpath);
                if (resolved)
                    return resolved;
            }
            if (dirname(current) === current)
                break;
        }
        for (const base of ['/usr/lib/node_modules', '/usr/share/pkg/node_modules']) {
            const candidate = join(base, packageName);
            if (filesystem().exists(candidate)) {
                const resolved = resolvePackageEntry(candidate, subpath);
                if (resolved)
                    return resolved;
            }
        }
        return null;
    }
    /** A conditional exports value (string | { require, default, import, ... }): require first, as CommonJS asks. */
    function resolveExportsCondition(value) {
        if (typeof value === 'string')
            return value;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const cond = value;
            if (typeof cond.require === 'string')
                return cond.require;
            if (typeof cond.default === 'string')
                return cond.default;
            if (typeof cond.import === 'string')
                return cond.import;
            // Nested conditions (e.g. { node: { require: ... } }); TS declarations are not code.
            for (const key of Object.keys(cond)) {
                if (key === 'types')
                    continue;
                const nested = resolveExportsCondition(cond[key]);
                if (nested)
                    return nested;
            }
        }
        return null;
    }
    function resolvePackageEntry(pkgDir, subpath) {
        const pkgJsonPath = join(pkgDir, 'package.json');
        let pkgJson = null;
        if (filesystem().exists(pkgJsonPath)) {
            try {
                pkgJson = JSON.parse(filesystem().readFileString(pkgJsonPath));
            }
            catch { /* ignore */ }
        }
        if (subpath) {
            // The exports map's `./sub` entry, or a `./dir/*` pattern; else the file itself.
            if (pkgJson?.exports && typeof pkgJson.exports === 'object') {
                const exportsMap = pkgJson.exports;
                const key = `./${subpath}`;
                if (key in exportsMap) {
                    const target = resolveExportsCondition(exportsMap[key]);
                    const resolved = target ? resolveFile(target, pkgDir) : null;
                    if (resolved)
                        return resolved;
                }
                for (const pattern of Object.keys(exportsMap)) {
                    if (!pattern.endsWith('/*') || !key.startsWith(pattern.slice(0, -1)))
                        continue;
                    const targetPattern = resolveExportsCondition(exportsMap[pattern]);
                    if (!targetPattern?.endsWith('/*'))
                        continue;
                    const resolved = resolveFile(targetPattern.slice(0, -1) + key.slice(pattern.length - 1), pkgDir);
                    if (resolved)
                        return resolved;
                }
            }
            return resolveFile(`./${subpath}`, pkgDir);
        }
        // exports["."] (or an exports that is itself the condition map), then main, then index.js.
        if (pkgJson?.exports) {
            const exportsVal = pkgJson.exports;
            let rootExport = null;
            if (typeof exportsVal === 'string') {
                rootExport = exportsVal;
            }
            else if (typeof exportsVal === 'object' && !Array.isArray(exportsVal)) {
                const exportsMap = exportsVal;
                rootExport = exportsMap['.'] ?? null;
                if (!rootExport && ('require' in exportsMap || 'import' in exportsMap || 'default' in exportsMap)) {
                    rootExport = exportsMap;
                }
            }
            const target = rootExport ? resolveExportsCondition(rootExport) : null;
            const resolved = target ? resolveFile(target, pkgDir) : null;
            if (resolved)
                return resolved;
        }
        if (typeof pkgJson?.main === 'string') {
            const resolved = resolveFile(`./${pkgJson.main}`, pkgDir);
            if (resolved)
                return resolved;
        }
        const indexPath = join(pkgDir, 'index.js');
        return filesystem().exists(indexPath) ? indexPath : null;
    }
    function wrapperArguments(filename, module, moduleScope) {
        const dir = filename === '[eval]' ? context.cwd : dirname(filename);
        const require = requireFrom(dir);
        const importMeta = {
            url: `file://${filename}`,
            dirname: dir,
            filename,
            require,
            resolve: (specifier) => { throw new Error(`import.meta.resolve('${specifier}') is not supported`); },
        };
        // import() as Node's: a promise, rejected (never thrown) when the module cannot load.
        const importDynamic = (specifier) => Promise.resolve().then(() => require(specifier));
        return [
            module.exports, require, module, filename, dir,
            moduleScope.console, moduleScope.process, Buffer,
            globalThis.setTimeout, globalThis.setInterval,
            globalThis.clearTimeout, globalThis.clearInterval,
            { process: moduleScope.process, Buffer, console: moduleScope.console },
            importMeta, importDynamic, require, module,
        ];
    }
    function load(filename, preread) {
        if (filename in cache)
            return cache[filename];
        const source = preread?.source ?? filesystem().readFileString(filename);
        if (filename.endsWith('.json')) {
            cache[filename] = JSON.parse(source);
            return cache[filename];
        }
        const module = { exports: {} };
        const initialExports = module.exports;
        // Cached before it runs, so a cycle sees its partial exports (Node.js behaviour).
        cache[filename] = initialExports;
        const clean = stripShebang(source);
        const esm = preread?.esm ?? treatAsEsm(clean, filename, () => packageType(filename, filesystem()));
        let fn;
        try {
            // A module that does not compile, lowered or as written, names its file.
            fn = new Function(`return ${moduleWrapper(clean, esm)}`)();
        }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.message = `[${filename}] ${err.message}`;
            throw err;
        }
        try {
            fn(...wrapperArguments(filename, module, scope(filename)));
        }
        catch (e) {
            if (e instanceof ProcessExitError)
                throw e;
            const err = e instanceof Error ? e : new Error(String(e));
            if (!err.message.includes('[/'))
                err.message = `[${filename}] ${err.message}`;
            throw err;
        }
        // module.exports reassigned (not just mutated): the cache holds what it became.
        if (module.exports !== initialExports)
            cache[filename] = module.exports;
        return module.exports;
    }
    return { moduleMap, requireFrom, load, wrapperArguments };
}
