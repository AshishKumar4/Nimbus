/**
 * Node's ESM resolver, for the process's `import()` (dynamic-import-rewrite.ts
 * turns each `import(x)` into a call of the shims' loader, which resolves
 * here). The algorithm, its conditions and its error codes and messages are
 * Node 22's (lib/internal/modules/esm/resolve.js, get_format.js), checked
 * against real node by tests/unit/esm-resolver-matches-node.mjs:
 *
 *   - relative and absolute specifiers resolve as URLs, with no extension or
 *     index probing; a directory is ERR_UNSUPPORTED_DIR_IMPORT, a miss
 *     ERR_MODULE_NOT_FOUND, each with the "Did you mean" hint Node derives
 *     from what `require` would have found;
 *   - `#name` resolves through the package scope's `imports`, a bare name
 *     through the package's own name (self-reference), then node_modules,
 *     then `exports` (conditions `node`, `import`, `module-sync`, `default`,
 *     and the program's own from `--conditions`, taken in the map's own key
 *     order) or the legacy main;
 *   - `file:`, `node:` and `data:` URLs; every other scheme is refused.
 *
 * The node shims embed it as source (scripts/bundle-facet-workers.mjs
 * compiles it into loaders/generated-workers.ts), so the resolver is one
 * self-contained function: nothing inside may refer to this module. A
 * program may have replaced built-ins by the time it resolves, so it calls
 * only those the launch captured (primordials.ts), as Node's loader calls
 * its primordials, and reads a parsed package.json's own fields alone, as
 * Node's reader does (tests/unit/primordials-audit.mjs); a URL's members
 * it reads live, as Node's does (package-map.ts urlPathname).
 */
import { invalidArgType, nodeError } from './node-error.js';
import { codeOf, createNodePackageMapPolicy, DEFAULT_ESM_CONDITIONS, nativeResolutionError, packageJsonText, selectPackageMap, urlHash, urlHref, urlPathname, urlProtocol, urlSearch, urlSetHash, urlSetPathname, urlSetSearch, } from './package-map.js';
import { arrayIsArray, dataDescriptor, decodeURIComponentOf, encodeURIComponentOf, Error, generatorNext, generatorThrow, JSONParse, JSONStringify, newURL, objectHasOwn, objectKeys, ownField, PromiseConstructor, reflectApply, reflectDefineProperty, reflectGet, reflectSet, regExpExec, SafeList, SafeMap, SafeSet, safeGenerator, stringEndsWith, stringIndexOf, stringLastIndexOf, stringSlice, stringStartsWith, TypeError, } from './primordials.js';
/** Node's ERR_UNKNOWN_FILE_EXTENSION message for the file at `path`. */
export function unknownFileExtensionMessage(path) {
    const base = stringSlice(path, stringLastIndexOf(path, '/') + 1);
    const dot = stringLastIndexOf(base, '.');
    return `Unknown file extension "${dot > 0 ? stringSlice(base, dot) : ''}" for ${path}`;
}
const ENCODED_SEPARATOR = /%2f|%5c/i;
const JSON_DATA_URL = /^data:application\/json(?:;[^,]*)?,/;
/** `text` with each run of slashes made one. */
function singleSlashes(text) {
    let out = '';
    for (let i = 0; i < text.length; i++)
        if (text[i] !== '/' || out[out.length - 1] !== '/')
            out += text[i];
    return out;
}
/** A specifier Node's package name check refuses: one starting with `.`, or holding `%` or `\`. */
function invalidPackageName(name) {
    if (name[0] === '.')
        return true;
    for (let i = 0; i < name.length; i++)
        if (name[i] === '%' || name[i] === '\\')
            return true;
    return false;
}
/** `path`'s non-empty segments. */
function segments(path) {
    const out = new SafeList();
    let start = 0;
    for (let i = 0; i <= path.length; i++) {
        if (i < path.length && path[i] !== '/')
            continue;
        if (i > start)
            out[out.length] = stringSlice(path, start, i);
        start = i + 1;
    }
    return out;
}
export function createEsmResolver(host, options = {}) {
    // The options read as the caller gave them, not as an object they inherit from has them.
    const conditions = new SafeSet();
    for (let i = 0; i < DEFAULT_ESM_CONDITIONS.length; i++)
        conditions.add(DEFAULT_ESM_CONDITIONS[i]);
    const given = ownField(options, 'conditions');
    if (arrayIsArray(given)) {
        const extra = given;
        for (let i = 0; i < extra.length; i++) {
            const condition = extra[i];
            if (typeof condition === 'string')
                conditions.add(condition);
        }
    }
    const typeScript = ownField(options, 'stripTypes') !== false;
    const cwdOf = ownField(options, 'cwd');
    const cwd = () => {
        if (typeof cwdOf !== 'function')
            return undefined;
        const dir = reflectApply(cwdOf, options, []);
        return typeof dir === 'string' ? dir : undefined;
    };
    // The host's questions, each yielded as-is and typed by what it answers.
    const ask = {
        kind: safeGenerator(function* (path) {
            const kind = yield host.kind(path);
            return kind === 'file' || kind === 'directory' ? kind : null;
        }),
        readText: safeGenerator(function* (path) {
            const text = yield host.readText(path);
            return typeof text === 'string' ? text : null;
        }),
        realpath: safeGenerator(function* (path) {
            const real = yield host.realpath(path);
            return typeof real === 'string' ? real : path;
        }),
        cjsResolve: safeGenerator(function* (specifier, parentPath) {
            const found = yield host.cjsResolve(specifier, parentPath);
            return typeof found === 'string' ? found : null;
        }),
    };
    const filePath = (url) => decodeURIComponentOf(urlPathname(typeof url === 'string' ? newURL(url) : url));
    const fileUrl = (path) => {
        const url = newURL('file://');
        urlSetPathname(url, path);
        return url;
    };
    /** An error that carries the URL it was resolving: import.meta.resolve answers with it, where import() rejects. */
    const withUrl = (error, url) => {
        reflectDefineProperty(error, 'url', dataDescriptor(urlHref(url), true, true, true));
        return error;
    };
    function isRelativeSpecifier(specifier) {
        if (specifier[0] !== '.')
            return false;
        if (specifier.length === 1 || specifier[1] === '/')
            return true;
        return specifier[1] === '.' && (specifier.length === 2 || specifier[2] === '/');
    }
    const isRelativeOrAbsolute = (specifier) => specifier !== '' && (specifier[0] === '/' || isRelativeSpecifier(specifier));
    const noConfig = (pjsonPath) => ({ exists: false, pjsonPath, name: undefined, main: undefined, exports: undefined, imports: undefined, type: 'none' });
    // Each package.json read once, as Node's reader holds the ones it read for
    // the process (src/node_modules.cc GetPackageJSON): a graph's modules share
    // their scopes, and asked them again per import (a launch over pi's 1074
    // modules). Like Node's, it holds no absence (a package.json written later
    // is read), and one that does not parse is read again, its refusal naming
    // each import. Its fields are its own (Node's reader is C++): none an
    // object the program changed lends it.
    const packageConfigs = new SafeMap();
    const readPackageConfig = safeGenerator(function* (pjsonPath, specifier, base) {
        const known = packageConfigs.get(pjsonPath);
        if (known !== undefined)
            return known;
        const text = (yield* ask.kind(pjsonPath)) === 'file' ? yield* ask.readText(pjsonPath) : null;
        if (text === null)
            return noConfig(pjsonPath);
        let parsed;
        try {
            parsed = JSONParse(packageJsonText(text));
        }
        catch {
            // Node's message names the file and the import, not the parse error; its C++ throws it.
            throw nativeResolutionError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${pjsonPath}` +
                (base ? ` while importing ${JSONStringify(specifier)} from ${base}` : '') + '.');
        }
        const config = { ...noConfig(pjsonPath), exists: true };
        packageConfigs.set(pjsonPath, config);
        if (parsed === null || typeof parsed !== 'object')
            return config;
        const name = ownField(parsed, 'name');
        const main = ownField(parsed, 'main');
        const imports = ownField(parsed, 'imports');
        const type = ownField(parsed, 'type');
        if (typeof name === 'string')
            config.name = name;
        if (typeof main === 'string')
            config.main = main;
        if (objectHasOwn(parsed, 'exports'))
            config.exports = reflectGet(parsed, 'exports');
        if (imports !== null && typeof imports === 'object')
            config.imports = imports;
        if (type === 'module' || type === 'commonjs')
            config.type = type;
        return config;
    });
    const packageScopeConfig = safeGenerator(function* (resolved) {
        const specifier = urlHref(resolved);
        let pjsonUrl = newURL('./package.json', resolved);
        let pathname = urlPathname(pjsonUrl);
        while (true) {
            if (stringEndsWith(pathname, 'node_modules/package.json'))
                break;
            const config = yield* readPackageConfig(decodeURIComponentOf(pathname), specifier, undefined);
            if (config.exists)
                return config;
            const last = pathname;
            pjsonUrl = newURL('../package.json', pjsonUrl);
            pathname = urlPathname(pjsonUrl);
            if (pathname === last)
                break;
        }
        return noConfig(decodeURIComponentOf(pathname));
    });
    function exportsNotFound(subpath, pjsonUrl, base) {
        const pkgPath = filePath(newURL('.', pjsonUrl));
        return nodeError(Error, 'ERR_PACKAGE_PATH_NOT_EXPORTED', subpath === '.'
            ? `No "exports" main defined in ${pkgPath}package.json imported from ${base}`
            : `Package subpath '${subpath}' is not defined by "exports" in ${pkgPath}package.json imported from ${base}`);
    }
    const packageExportsResolve = safeGenerator(function* (pjsonUrl, subpath, config, base) {
        const policy = createNodePackageMapPolicy(pjsonUrl, base, false, (target) => packageResolve(target, urlHref(pjsonUrl)));
        const result = yield* selectPackageMap(config.exports, subpath, conditions, policy);
        if (result == null)
            throw exportsNotFound(subpath, pjsonUrl, base);
        return result;
    });
    const packageImportsResolve = safeGenerator(function* (name, baseUrl) {
        const base = filePath(baseUrl);
        if (name === '#' || stringStartsWith(name, '#/') || stringEndsWith(name, '/')) {
            throw nodeError(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${name}" is not a valid internal imports specifier name imported from ${base}`);
        }
        const config = yield* packageScopeConfig(newURL(baseUrl));
        if (config.exists && config.imports) {
            const pjsonUrl = fileUrl(config.pjsonPath);
            const policy = createNodePackageMapPolicy(pjsonUrl, base, true, (target) => packageResolve(target, urlHref(pjsonUrl)));
            const result = yield* selectPackageMap(config.imports, name, conditions, policy);
            if (result != null)
                return result;
        }
        const where = config.exists ? ` in package ${filePath(newURL('.', fileUrl(config.pjsonPath)))}package.json` : '';
        throw nodeError(TypeError, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${name}" is not defined${where} imported from ${base}`);
    });
    const MAIN_SUFFIXES = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'];
    const INDEX_FILES = ['./index.js', './index.json', './index.node'];
    const legacyMainResolve = safeGenerator(function* (pjsonUrl, config, base) {
        const tries = new SafeList();
        if (config.main !== undefined) {
            for (let i = 0; i < MAIN_SUFFIXES.length; i++)
                tries[tries.length] = `./${config.main}${MAIN_SUFFIXES[i]}`;
        }
        for (let i = 0; i < INDEX_FILES.length; i++)
            tries[tries.length] = INDEX_FILES[i];
        for (let i = 0; i < tries.length; i++) {
            const url = newURL(tries[i], pjsonUrl);
            if ((yield* ask.kind(filePath(url))) === 'file')
                return url;
        }
        // Named by its main, or index.js, in the package's directory (a path, so
        // an empty package name's `node_modules//` is `node_modules/`).
        const dir = fileUrl(singleSlashes(filePath(newURL('.', pjsonUrl))));
        const missing = filePath(newURL(config.main ?? 'index.js', dir));
        throw nativeResolutionError('ERR_MODULE_NOT_FOUND', `Cannot find package '${missing}' imported from ${base}`);
    });
    const packageResolve = safeGenerator(function* (specifier, baseUrl) {
        if (host.isBuiltin(specifier))
            return newURL('node:' + specifier);
        const base = filePath(baseUrl);
        let separator = stringIndexOf(specifier, '/');
        let valid = true;
        let scoped = false;
        if (specifier[0] === '@') {
            scoped = true;
            if (separator === -1 || specifier.length === 0)
                valid = false;
            else
                separator = stringIndexOf(specifier, '/', separator + 1);
        }
        const name = separator === -1 ? specifier : stringSlice(specifier, 0, separator);
        if (invalidPackageName(name))
            valid = false;
        if (!valid) {
            throw nodeError(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${specifier}" is not a valid package name imported from ${base}`);
        }
        const subpath = '.' + (separator === -1 ? '' : stringSlice(specifier, separator));
        const self = yield* packageScopeConfig(newURL(baseUrl));
        if (self.exists && self.exports != null && self.name === name) {
            return yield* packageExportsResolve(fileUrl(self.pjsonPath), subpath, self, base);
        }
        let pjsonUrl = newURL('./node_modules/' + name + '/package.json', baseUrl);
        let pjsonPath = filePath(pjsonUrl);
        let lastPath;
        do {
            if ((yield* ask.kind(stringSlice(pjsonPath, 0, pjsonPath.length - 13))) !== 'directory') {
                lastPath = pjsonPath;
                pjsonUrl = newURL((scoped ? '../../../../node_modules/' : '../../../node_modules/') + name + '/package.json', pjsonUrl);
                pjsonPath = filePath(pjsonUrl);
                continue;
            }
            const config = yield* readPackageConfig(pjsonPath, specifier, base);
            if (config.exports != null)
                return yield* packageExportsResolve(pjsonUrl, subpath, config, base);
            if (subpath === '.')
                return yield* legacyMainResolve(pjsonUrl, config, base);
            return newURL(subpath, pjsonUrl);
        } while (pjsonPath.length !== lastPath.length);
        throw nodeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find package '${name}' imported from ${base}`);
    });
    const formatOf = safeGenerator(function* (url, path) {
        const base = stringSlice(path, stringLastIndexOf(path, '/') + 1);
        const dot = stringLastIndexOf(base, '.');
        const ext = dot > 0 ? stringSlice(base, dot) : '';
        if (ext === '.mjs' || (ext === '.mts' && typeScript))
            return 'module';
        if (ext === '.cjs' || (ext === '.cts' && typeScript))
            return 'commonjs';
        if (ext === '.json')
            return 'json';
        if (ext === '.js' || (ext === '.ts' && typeScript) || ext === '') {
            const type = (yield* packageScopeConfig(url)).type;
            if (type === 'module')
                return 'module';
            if (type === 'commonjs')
                return 'commonjs';
            return 'detect';
        }
        return 'unknown';
    });
    const finalizeResolution = safeGenerator(function* (resolved, baseUrl) {
        // The importer's path, which only a refusal names.
        const base = () => filePath(baseUrl);
        const pathname = urlPathname(resolved);
        if (regExpExec(ENCODED_SEPARATOR, pathname) !== null) {
            throw nodeError(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${pathname}" must not include encoded "/" or "\\" characters imported from ${base()}`);
        }
        const path = decodeURIComponentOf(pathname);
        // Node stats the path's last character when it ends in "/", which is
        // always a directory: a trailing slash is a directory import.
        const kind = stringEndsWith(path, '/') ? 'directory' : yield* ask.kind(path);
        if (kind === 'directory') {
            throw withUrl(nodeError(Error, 'ERR_UNSUPPORTED_DIR_IMPORT', `Directory import '${path}' is not supported resolving ES modules imported from ${base()}`), resolved);
        }
        if (kind !== 'file') {
            throw withUrl(nodeError(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find module '${path}' imported from ${base()}`), resolved);
        }
        // The module is its real file, as node's loader names it; the query and
        // fragment stay the specifier's.
        const real = yield* ask.realpath(path);
        const url = fileUrl(real);
        urlSetSearch(url, urlSearch(resolved));
        urlSetHash(url, urlHash(resolved));
        return { url: urlHref(url), location: url, path: real, builtin: undefined };
    });
    const moduleResolve = safeGenerator(function* (specifier, parentUrl) {
        let resolved;
        if (isRelativeOrAbsolute(specifier)) {
            try {
                resolved = newURL(specifier, parentUrl);
            }
            catch {
                throw unsupportedResolveRequest(specifier, parentUrl);
            }
        }
        else if (specifier[0] === '#')
            resolved = yield* packageImportsResolve(specifier, parentUrl);
        else {
            try {
                resolved = newURL(specifier);
            }
            catch {
                resolved = yield* packageResolve(specifier, parentUrl);
            }
        }
        const protocol = urlProtocol(resolved);
        if (protocol === 'node:')
            return { url: 'node:' + urlPathname(resolved), location: undefined, path: undefined, builtin: urlPathname(resolved) };
        if (protocol !== 'file:')
            return { url: urlHref(resolved), location: undefined, path: undefined, builtin: undefined };
        return yield* finalizeResolution(resolved, parentUrl);
    });
    /** What loading a resolution checks first: its scheme, builtin and format. */
    const loadable = safeGenerator(function* (resolved) {
        if (resolved.builtin !== undefined) {
            if (!host.isBuiltin('node:' + resolved.builtin)) {
                throw nodeError(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: node:${resolved.builtin}`);
            }
            return { url: resolved.url, path: undefined, builtin: resolved.builtin, format: 'builtin' };
        }
        if (stringStartsWith(resolved.url, 'data:'))
            return { url: resolved.url, path: undefined, builtin: undefined, format: 'data' };
        if (resolved.path === undefined) {
            throw nodeError(Error, 'ERR_UNSUPPORTED_ESM_URL_SCHEME', `Only URLs with a scheme in: file and data are supported by the default ESM loader. Received protocol '${urlProtocol(newURL(resolved.url))}'`);
        }
        return { url: resolved.url, path: resolved.path, builtin: undefined, format: yield* formatOf(resolved.location ?? newURL(resolved.url), resolved.path) };
    });
    /**
     * Node's resolveAsCommonJS: the hint an ESM miss carries. Its CommonJS
     * module has no filename, so Node's require resolves a relative
     * specifier from the working directory (Module._resolveLookupPaths' ['.'])
     * and the hint is that file relative to the importer.
     */
    const commonJsHint = safeGenerator(function* (specifier, parentUrl) {
        const dir = cwd();
        let from = filePath(parentUrl);
        if (isRelativeSpecifier(specifier) && dir !== undefined) {
            let end = dir.length;
            while (end > 0 && dir[end - 1] === '/')
                end--;
            from = `${stringSlice(dir, 0, end)}/[cwd]`;
        }
        let found = yield* ask.cjsResolve(specifier, from);
        if (found === null)
            return null;
        if (isRelativeSpecifier(specifier)) {
            const fromParts = segments(stringSlice(parentUrl, 'file://'.length, stringLastIndexOf(parentUrl, '/')));
            const toParts = segments(urlPathname(fileUrl(found)));
            let common = 0;
            while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common])
                common++;
            let relative = '';
            for (let i = common; i < fromParts.length; i++)
                relative += relative === '' ? '..' : '/..';
            for (let i = common; i < toParts.length; i++)
                relative += relative === '' ? toParts[i] : `/${toParts[i]}`;
            found = stringStartsWith(relative, '../') ? relative : `./${relative}`;
        }
        else if (specifier[0] && specifier[0] !== '/' && specifier[0] !== '.') {
            const slash = stringIndexOf(specifier, '/');
            const pkg = slash === -1 ? specifier : stringSlice(specifier, 0, slash);
            const needle = `/node_modules/${pkg}/`;
            const at = stringLastIndexOf(found, needle);
            if (at === -1)
                found = urlHref(fileUrl(found));
            else {
                const rest = segmentsAll(stringSlice(found, at + needle.length));
                let encoded = pkg;
                for (let i = 0; i < rest.length; i++)
                    encoded += `/${encodeURIComponentOf(rest[i])}`;
                found = encoded;
            }
        }
        return found;
    });
    const resolveWithHint = safeGenerator(function* (specifier, parentUrl) {
        try {
            return yield* moduleResolve(specifier, parentUrl);
        }
        catch (error) {
            const code = codeOf(error);
            if (error instanceof Error && (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT')) {
                const asGiven = stringStartsWith(specifier, 'file://') ? filePath(specifier) : specifier;
                const found = yield* commonJsHint(asGiven, parentUrl);
                if (found && found !== asGiven)
                    reflectSet(error, 'message', `${reflectGet(error, 'message')}\nDid you mean to import ${JSONStringify(found)}?`);
            }
            throw error;
        }
    });
    const importTarget = safeGenerator(function* (specifier, parentUrl) {
        return yield* loadable(yield* resolveWithHint(specifier, parentUrl));
    });
    /** Node's import.meta.resolve: the URL, even of a file or directory that will not load. */
    const metaResolve = safeGenerator(function* (specifier, parentUrl) {
        try {
            return (yield* moduleResolve(specifier, parentUrl)).url;
        }
        catch (error) {
            const code = codeOf(error);
            if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT') && error !== null && typeof error === 'object') {
                const url = reflectGet(error, 'url');
                if (typeof url === 'string')
                    return url;
            }
            throw error;
        }
    });
    function runSync(steps) {
        let next = generatorNext(steps);
        while (!next.done) {
            if (next.value instanceof PromiseConstructor)
                throw new Error('resolveSync: the host answered asynchronously');
            next = generatorNext(steps, next.value);
        }
        return next.value;
    }
    async function runAsync(steps) {
        let next = generatorNext(steps);
        while (!next.done) {
            let answer;
            try {
                answer = await next.value;
            }
            catch (error) {
                next = generatorThrow(steps, error);
                continue;
            }
            next = generatorNext(steps, answer);
        }
        return next.value;
    }
    return {
        resolve: (specifier, parentUrl) => runAsync(importTarget(specifier, parentUrl)),
        resolveSync: (specifier, parentUrl) => runSync(importTarget(specifier, parentUrl)),
        metaResolveSync: (specifier, parentUrl) => runSync(metaResolve(specifier, parentUrl)),
        packageScopeSync(url) {
            const { exists, pjsonPath, type } = runSync(packageScopeConfig(newURL(url)));
            return { exists, pjsonPath, type };
        },
        async packageScope(url) {
            const { exists, pjsonPath, type } = await runAsync(packageScopeConfig(newURL(url)));
            return { exists, pjsonPath, type };
        },
        assertLoadable(resolution) {
            if (resolution.format !== 'unknown' || resolution.path === undefined)
                return;
            throw nodeError(TypeError, 'ERR_UNKNOWN_FILE_EXTENSION', unknownFileExtensionMessage(resolution.path));
        },
        validateAttributes(url, format, attributes) {
            const keys = objectKeys(attributes);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] !== 'type') {
                    throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "${keys[i]}" with value "${reflectGet(attributes, keys[i])}" is not supported in ${url}`);
                }
            }
            // The import's own attributes (V8's object for them inherits nothing).
            const type = ownField(attributes, 'type');
            // Keep the data-URL loading route, but validate its media type like
            // the equivalent file format. application/json still requires type.
            if (format === 'json' || (format === 'data' && regExpExec(JSON_DATA_URL, url) !== null)) {
                if (type === 'json')
                    return;
                if (!objectHasOwn(attributes, 'type')) {
                    throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_MISSING', `Module "${url}" needs an import attribute of "type: json"`);
                }
            }
            else if (type == null) {
                return;
            }
            if (typeof type !== 'string') {
                throw invalidArgType('type', 'string', type);
            }
            if (type !== 'json') {
                throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "type" with value "${type}" is not supported in ${url}`);
            }
            throw nodeError(TypeError, 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${url}" is not of type "json"`);
        },
    };
}
/**
 * Node's refusal of a relative or absolute specifier that is no URL against
 * its importer's (resolve.js moduleResolve): ERR_UNSUPPORTED_RESOLVE_REQUEST,
 * its own `cause` the URL parser's ERR_INVALID_URL, with the input and the
 * base (lib/internal/url.js), whatever the realm's parser said.
 */
export function unsupportedResolveRequest(specifier, parentUrl) {
    const error = nodeError(TypeError, 'ERR_UNSUPPORTED_RESOLVE_REQUEST', `Failed to resolve module specifier "${specifier}" from "${parentUrl}": Invalid relative URL or base scheme is not hierarchical.`);
    const cause = nodeError(TypeError, 'ERR_INVALID_URL', 'Invalid URL', { input: specifier, base: parentUrl });
    reflectDefineProperty(error, 'cause', dataDescriptor(cause, true, true, true));
    return error;
}
/** `path`'s segments, empty ones included (Node's StringPrototypeSplit(path, '/')). */
function segmentsAll(path) {
    const out = new SafeList();
    let start = 0;
    for (let i = 0; i <= path.length; i++) {
        if (i < path.length && path[i] !== '/')
            continue;
        out[out.length] = stringSlice(path, start, i);
        start = i + 1;
    }
    return out;
}
