import { createModuleMap, ProcessExitError } from './index.js';
import { createModuleShim } from './module.js';
import { Buffer } from './buffer.js';
import { escapedIdentifierNames, rewriteDynamicImports } from '../../../runtime/dynamic-import-rewrite.js';
import { declaredPackageType, isEsModuleFile } from '../../../runtime/module-format.js';
import { fileURLToPath, pathToFileURL } from './url.js';
import { resolve, dirname, join, extname } from '../utils/path.js';
import { DEFAULT_CJS_CONDITIONS, parseResolvablePackageJson, resolveExports, } from '../../../_shared/exports-resolver.js';
const REQUIRE_CONDITIONS = [...DEFAULT_CJS_CONDITIONS, 'module-sync'];
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
/** Nearest package.json "type" walking up from a file (Node.js semantics), read synchronously inside `require`. */
function packageType(filename, vfs) {
    for (let dir = dirname(filename);; dir = dirname(dir)) {
        const pkgPath = join(dir, 'package.json');
        if (vfs.exists(pkgPath))
            return declaredPackageType(vfs.readFileString(pkgPath));
        if (dirname(dir) === dir)
            return null;
    }
}
// The wrapper every module runs in: CommonJS's five names and the globals a
// module may find as free variables, then import()'s loader under a name the
// source does not hold (wrapperArguments passes them in this order).
const WRAPPER_PARAMS = 'exports, require, module, __filename, __dirname, console, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, global';
/**
 * A CommonJS body as written, but for import() calls routed to the native
 * loader. The extra parameter cannot collide with a source's own name,
 * including a Unicode-escaped spelling.
 */
export function moduleWrapper(source, parentUrl) {
    const escaped = source.includes('\\u') ? escapedIdentifierNames(source) : new Set();
    let index = 0;
    let loader;
    do {
        loader = `__lifoImport${index++}`;
    } while (source.includes(loader) || escaped.has(loader));
    const body = rewriteDynamicImports(source, parentUrl, loader);
    return `(function(${WRAPPER_PARAMS}, ${loader}) {\n${body}\n})`;
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
    let native;
    const cache = Object.create(null);
    // createRequire(filename) is require as a module at `filename` has it: a path, or a file: URL's decoded path.
    moduleMap.module = () => createModuleShim(moduleMap, (filename) => {
        const path = filename instanceof URL || String(filename).startsWith('file:') ? fileURLToPath(filename) : String(filename);
        return requireFrom(dirname(path), path);
    });
    function requireFrom(dir, parentFilename) {
        const req = ((id) => requireModule(id, dir, parentFilename));
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
    function requireModule(id, dir, parentFilename) {
        const name = id.startsWith('node:') ? id.slice(5) : id;
        if (moduleMap[name]) {
            if (!builtins.has(name))
                builtins.set(name, moduleMap[name]());
            return builtins.get(name);
        }
        const path = resolveFilename(name, dir);
        if (path !== null)
            return load(path, undefined, parentFilename);
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
    /** The nearest package.json at or above `dir`, its directory and its entry fields. */
    function nearestPackage(dir) {
        for (let current = dir;; current = dirname(current)) {
            const pkgPath = join(current, 'package.json');
            if (filesystem().exists(pkgPath))
                return { dir: current, pkg: parseResolvablePackageJson(filesystem().readFileString(pkgPath)) };
            if (dirname(current) === current)
                return null;
        }
    }
    /** A `#` name from the nearest package.json's "imports", as Node reads it (the nearest package.json wins). */
    function resolvePackageImport(name, fromDir) {
        const nearest = nearestPackage(fromDir);
        const target = nearest?.pkg ? resolveExports(nearest.pkg.imports, name, REQUIRE_CONDITIONS) : null;
        return target && nearest ? resolveFile(target, nearest.dir) : null;
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
    /**
     * A package's file for `subpath` (null for its root), as Node's require
     * finds it: where the package declares "exports", they decide (a subpath
     * they do not export, or export as null, is not found); else the subpath
     * as a file, or for the root its "main", then its index.js.
     */
    function resolvePackageEntry(pkgDir, subpath) {
        const pkgJsonPath = join(pkgDir, 'package.json');
        const pkg = filesystem().exists(pkgJsonPath) ? parseResolvablePackageJson(filesystem().readFileString(pkgJsonPath)) : null;
        const relative = (target) => (target.startsWith('.') || target.startsWith('/') ? target : `./${target}`);
        if (pkg?.exports !== undefined && pkg.exports !== null) {
            const target = resolveExports(pkg.exports, subpath ? `./${subpath}` : '.', REQUIRE_CONDITIONS);
            return target ? resolveFile(relative(target), pkgDir) : null;
        }
        if (subpath)
            return resolveFile(`./${subpath}`, pkgDir);
        const main = pkg?.main ? resolveFile(relative(pkg.main), pkgDir) : null;
        const indexPath = join(pkgDir, 'index.js');
        return main ?? (filesystem().exists(indexPath) ? indexPath : null);
    }
    function wrapperArguments(filename, module, moduleScope) {
        const dir = filename === '[eval]' ? context.cwd : dirname(filename);
        const require = requireFrom(dir, filename);
        // Resolution failures reject import()'s promise; none are thrown by the call itself.
        const importDynamic = (parentUrl, specifier, options) => Promise.resolve().then(() => {
            if (!native)
                throw new Error('Native ES modules require a lifo native module loader');
            return native.importModule(specifier, parentUrl, options);
        });
        return [
            module.exports, require, module, filename, dir,
            moduleScope.console, moduleScope.process, Buffer,
            globalThis.setTimeout, globalThis.setInterval,
            globalThis.clearTimeout, globalThis.clearInterval,
            { process: moduleScope.process, Buffer, console: moduleScope.console },
            importDynamic,
        ];
    }
    function load(filename, preread, parentFilename) {
        if (filename in cache)
            return cache[filename];
        const source = preread?.source ?? filesystem().readFileString(filename);
        if (filename.endsWith('.json')) {
            cache[filename] = JSON.parse(source);
            return cache[filename];
        }
        const clean = stripShebang(source);
        const esm = preread?.esm ?? isEsModuleFile(filename, clean, () => packageType(filename, filesystem()));
        if (esm) {
            if (!native)
                throw new Error('Native ES modules require a lifo native module loader');
            return native.requireModule(filename, parentFilename);
        }
        const module = { exports: {} };
        const initialExports = module.exports;
        // Cached before it runs, so a cycle sees its partial exports (Node.js behaviour).
        cache[filename] = initialExports;
        let fn;
        try {
            fn = new Function(`return ${moduleWrapper(clean, pathToFileURL(filename).href)}`)();
        }
        catch (e) {
            delete cache[filename];
            const err = e instanceof Error ? e : new Error(String(e));
            err.message = `[${filename}] ${err.message}`;
            throw err;
        }
        try {
            fn(...wrapperArguments(filename, module, scope(filename)));
        }
        catch (e) {
            delete cache[filename];
            if (e instanceof ProcessExitError)
                throw e;
            const err = e instanceof Error ? e : new Error(String(e));
            if (Reflect.get(err, 'code') === 'ERR_REQUIRE_ASYNC_MODULE' || Reflect.get(err, 'code') === 'ERR_REQUIRE_CYCLE_MODULE')
                throw err;
            if (!err.message.includes('[/'))
                err.message = `[${filename}] ${err.message}`;
            throw err;
        }
        // module.exports reassigned (not just mutated): the cache holds what it became.
        if (module.exports !== initialExports)
            cache[filename] = module.exports;
        return module.exports;
    }
    return { moduleMap, requireFrom, resolveFilename, load, wrapperArguments, setNativeLoader: (loader) => { native = loader; } };
}
