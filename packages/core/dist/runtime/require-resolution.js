import { createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, nativeResolutionError, packageJsonText, packageSelfReferenceSubpath, resolutionError, selectPackageMap, resolvePackageEntry, } from '../_shared/exports-resolver.js';
import { TYPESCRIPT_INDEX_CANDIDATES, typescriptFallbackCandidates } from '../_shared/typescript-specifiers.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';
export const METADATA_CANDIDATE_WORK = 256;
export const NODE_REQUIRE_POLICY = { name: 'node-commonjs' };
/**
 * Nimbus source execution accepts Bun/NodeNext .js -> .ts and index.ts only
 * after Node's ordinary candidates miss. Package-map targets remain exact.
 */
export const NIMBUS_TYPESCRIPT_REQUIRE_POLICY = {
    name: 'nimbus-typescript-source-fallback', typescriptFallback: true,
};
const codeOf = (error) => error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
const absolute = (path) => '/' + stripLeadingSlashes(normalizeVfsPath(path));
const parentDir = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
const relativeRequest = (id) => id === '.' || id === '..' || id.startsWith('./') || id.startsWith('../');
const fileUrl = (path) => {
    const url = new URL('file://');
    url.pathname = path;
    return url;
};
const error = resolutionError;
/** A module require() did not find: a plain Error, its code MODULE_NOT_FOUND, as Node's CJS loader makes it. */
const moduleNotFound = (message, props) => Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' }, props);
/** Node's node_modules lookup paths, with no node_modules/node_modules. */
export function requireNodeModulePaths(fromDir) {
    const paths = [];
    for (let dir = absolute(fromDir);; dir = parentDir(dir)) {
        if (dir.slice(dir.lastIndexOf('/') + 1) !== 'node_modules')
            paths.push((dir === '/' ? '' : dir) + '/node_modules');
        if (dir === '/')
            return paths;
    }
}
export function createRequireResolver(host, options = {}) {
    const conditions = new Set([...DEFAULT_CJS_CONDITIONS, ...(options.conditions ?? [])]);
    const policy = options.policy ?? NODE_REQUIRE_POLICY;
    const ask = {
        *kind(path) {
            if (options.progress)
                yield options.progress(METADATA_CANDIDATE_WORK + path.length);
            try {
                const kind = yield host.kind(path);
                return kind === 'file' || kind === 'directory' ? kind : null;
            }
            catch (err) {
                if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR')
                    return null;
                throw err;
            }
        },
        *text(path) {
            const text = yield host.readText(path);
            if (typeof text !== 'string')
                return null;
            if (options.progress)
                yield options.progress(text.length);
            return text;
        },
        *realpath(path) {
            const real = yield host.realpath(path);
            if (typeof real !== 'string')
                throw new Error('The CommonJS host must answer realpath with a path');
            return absolute(real);
        },
    };
    function* readPackage(path, state, scope = false) {
        if (state.configs.has(path))
            return state.configs.get(path) ?? null;
        let kind;
        try {
            kind = yield* ask.kind(path);
        }
        catch (err) {
            // Named authority policy shared with packageJsonVisible: an inaccessible
            // enclosing directory is not a package scope of this principal.
            if (scope && codeOf(err) === 'EACCES')
                return null;
            throw err;
        }
        if (kind !== 'file') {
            state.configs.set(path, null);
            return null;
        }
        const text = yield* ask.text(path);
        if (text === null) {
            state.configs.set(path, null);
            return null;
        }
        let pkg;
        try {
            pkg = JSON.parse(packageJsonText(text));
        }
        catch {
            throw nativeResolutionError('ERR_INVALID_PACKAGE_CONFIG', 'Invalid package config ' + path + '.');
        }
        const config = pkg !== null && typeof pkg === 'object' ? pkg : {};
        state.configs.set(path, config);
        return config;
    }
    function* nearestPackageScope(fromDir, state) {
        for (let dir = absolute(fromDir);; dir = parentDir(dir)) {
            if (dir.slice(dir.lastIndexOf('/') + 1) === 'node_modules')
                return null;
            const packageJsonPath = (dir === '/' ? '' : dir) + '/package.json';
            const pkg = yield* readPackage(packageJsonPath, state, true);
            if (pkg)
                return {
                    dir, packageJsonPath, pkg,
                    type: pkg.type === 'module' || pkg.type === 'commonjs' ? pkg.type : null,
                };
            if (dir === '/')
                return null;
        }
    }
    function* loadAsFile(path) {
        for (const suffix of ['', '.js', '.json', '.node']) {
            const candidate = absolute(path + suffix);
            if ((yield* ask.kind(candidate)) === 'file')
                return candidate;
        }
        return null;
    }
    function* loadIndex(path) {
        for (const suffix of ['/index.js', '/index.json', '/index.node']) {
            const candidate = absolute(path + suffix);
            if ((yield* ask.kind(candidate)) === 'file')
                return candidate;
        }
        return null;
    }
    function* loadAsDirectory(path, state) {
        if ((yield* ask.kind(path)) !== 'directory')
            return null;
        const pkgPath = (path === '/' ? '' : path) + '/package.json';
        const pkg = yield* readPackage(pkgPath, state);
        if (typeof pkg?.main === 'string' && pkg.main) {
            const main = absolute(pkg.main.startsWith('/') ? pkg.main : path + '/' + pkg.main);
            // Node does not read a second package.json at main: it tries main as
            // a file and then main/index, never recursively LOAD_AS_DIRECTORY.
            const found = (yield* loadAsFile(main)) ?? (yield* loadIndex(main)) ?? (yield* loadIndex(path));
            if (found)
                return found;
            if (policy.typescriptFallback) {
                const source = (yield* typeScriptFallback(main)) ?? (yield* typeScriptFallback(path));
                if (source)
                    return source;
            }
            throw moduleNotFound("Cannot find module '" + main + "'. Please verify that the package.json has a valid \"main\" entry", { path: pkgPath, requestPath: path });
        }
        return yield* loadIndex(path);
    }
    function* resolveFile(path, state, trailingSlash = false) {
        const normalized = absolute(path);
        const found = (!trailingSlash ? yield* loadAsFile(normalized) : null) ?? (yield* loadAsDirectory(normalized, state));
        return found ?? (policy.typescriptFallback ? yield* typeScriptFallback(normalized) : null);
    }
    function* typeScriptFallback(path) {
        for (const candidate of typescriptFallbackCandidates(path)) {
            if ((yield* ask.kind(candidate)) === 'file')
                return candidate;
        }
        if ((yield* ask.kind(path)) === 'directory') {
            for (const suffix of TYPESCRIPT_INDEX_CANDIDATES) {
                if ((yield* ask.kind(path + suffix)) === 'file')
                    return path + suffix;
            }
        }
        return null;
    }
    function exportsNotFound(subpath, pjsonPath) {
        return error('ERR_PACKAGE_PATH_NOT_EXPORTED', subpath === '.'
            ? 'No "exports" main defined in ' + pjsonPath
            : "Package subpath '" + subpath + "' is not defined by \"exports\" in " + pjsonPath);
    }
    function* resolveMap(field, name, pjsonPath, fromDir, internal, state) {
        const url = fileUrl(pjsonPath);
        const mapPolicy = createNodePackageMapPolicy(url, fromDir, internal, (target) => resolveBareTarget(target, parentDir(pjsonPath), state));
        return yield* selectPackageMap(field, name, conditions, mapPolicy);
    }
    /** ESM PACKAGE_RESOLVE for a bare imports target, under require's conditions. */
    function* resolveBareTarget(name, fromDir, state) {
        if (host.isBuiltin?.(name))
            return new URL(name.startsWith('node:') ? name : 'node:' + name);
        const split = packageName(name);
        if (!split || /^\.|%|\\/.test(split.name)) {
            throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + name + '" is not a valid package name imported from ' + fromDir, TypeError);
        }
        const self = yield* nearestPackageScope(fromDir, state);
        const selfSubpath = packageSelfReferenceSubpath(self?.pkg, name);
        if (self && selfSubpath !== null) {
            const target = yield* resolveMap(self.pkg.exports, selfSubpath, self.packageJsonPath, fromDir, false, state);
            if (target == null)
                throw exportsNotFound(selfSubpath, self.packageJsonPath);
            return target;
        }
        for (const folder of requireNodeModulePaths(fromDir)) {
            const dir = folder + '/' + split.name;
            if ((yield* ask.kind(dir)) !== 'directory')
                continue;
            const pjsonPath = dir + '/package.json';
            const pkg = yield* readPackage(pjsonPath, state);
            if (pkg?.exports != null) {
                const target = yield* resolveMap(pkg.exports, split.subpath, pjsonPath, fromDir, false, state);
                if (target == null)
                    throw exportsNotFound(split.subpath, pjsonPath);
                return target;
            }
            if (split.subpath !== '.')
                return new URL(split.subpath, fileUrl(pjsonPath));
            const found = yield* loadAsDirectory(dir, state);
            if (found)
                return fileUrl(found);
            // legacyMainResolve's.
            throw nativeResolutionError('ERR_MODULE_NOT_FOUND', "Cannot find package '" + dir + "/index.js' imported from " + fromDir);
        }
        throw error('ERR_MODULE_NOT_FOUND', "Cannot find package '" + split.name + "' imported from " + fromDir);
    }
    function packageName(id) {
        let slash = id.indexOf('/');
        if (id.startsWith('@')) {
            if (slash === -1)
                return null;
            slash = id.indexOf('/', slash + 1);
        }
        return { name: slash === -1 ? id : id.slice(0, slash), subpath: slash === -1 ? '.' : '.' + id.slice(slash) };
    }
    function* finalizeTarget(target, pjsonPath) {
        if (target.protocol !== 'file:')
            throw error('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file', TypeError);
        if (/%2f|%5c/i.test(target.pathname)) {
            throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + target.pathname + '" must not include encoded "/" or "\\" characters', TypeError);
        }
        const path = decodeURIComponent(target.pathname);
        if ((yield* ask.kind(path)) !== 'file') {
            throw moduleNotFound("Cannot find module '" + path + "'", { path: pjsonPath });
        }
        return absolute(path);
    }
    function* loadPackageSelf(name, fromDir, state) {
        const scope = yield* nearestPackageScope(fromDir, state);
        const subpath = packageSelfReferenceSubpath(scope?.pkg, name);
        if (!scope || subpath === null)
            return null;
        const target = yield* resolveMap(scope.pkg.exports, subpath, scope.packageJsonPath, fromDir, false, state);
        if (target == null)
            throw exportsNotFound(subpath, scope.packageJsonPath);
        return yield* finalizeTarget(target, scope.packageJsonPath);
    }
    function* loadNodeModules(name, folders, fromDir, state) {
        const split = packageName(name);
        for (const folder of folders) {
            if (split && split.name !== '' && !name.includes('\\')) {
                const pjsonPath = absolute(folder + '/' + split.name + '/package.json');
                const pkg = yield* readPackage(pjsonPath, state);
                if (pkg?.exports != null) {
                    const target = yield* resolveMap(pkg.exports, split.subpath, pjsonPath, fromDir, false, state);
                    if (target == null)
                        throw exportsNotFound(split.subpath, pjsonPath);
                    return yield* finalizeTarget(target, pjsonPath);
                }
            }
            const found = yield* resolveFile(folder + '/' + name, state, name.endsWith('/'));
            if (found)
                return found;
        }
        return null;
    }
    function* resolvePath(id, fromDir, request, state) {
        const dir = absolute(fromDir);
        if (id === '')
            return null;
        if (host.isBuiltin?.(id))
            return new URL(id.startsWith('node:') ? id : 'node:' + id);
        if (id.startsWith('/'))
            return yield* resolveFile(id, state, id.endsWith('/'));
        if (relativeRequest(id)) {
            for (const origin of request.paths ?? [dir]) {
                const found = yield* resolveFile(origin + '/' + id, state, id.endsWith('/') || id === '.' || id === '..' || id.endsWith('/.') || id.endsWith('/..'));
                if (found)
                    return found;
            }
            return null;
        }
        if (id.startsWith('#')) {
            const scope = yield* nearestPackageScope(dir, state);
            if (scope && scope.pkg.imports != null) {
                const from = request.parent ?? dir;
                if (id === '#' || id.startsWith('#/') || id.endsWith('/')) {
                    throw error('ERR_INVALID_MODULE_SPECIFIER', 'Invalid module "' + id + '" is not a valid internal imports specifier name imported from ' + from, TypeError);
                }
                let target;
                try {
                    target = yield* resolveMap(scope.pkg.imports, id, scope.packageJsonPath, from, true, state);
                }
                catch (err) {
                    // Node's CJS boundary translates an ESM PACKAGE_RESOLVE miss to
                    // its own MODULE_NOT_FOUND, with this require's stack.
                    if (codeOf(err) === 'ERR_MODULE_NOT_FOUND')
                        return null;
                    throw err;
                }
                if (target != null)
                    return yield* finalizeTarget(target, scope.packageJsonPath);
                throw error('ERR_PACKAGE_IMPORT_NOT_DEFINED', 'Package import specifier "' + id + '" is not defined in package ' + scope.packageJsonPath + ' imported from ' + from, TypeError);
            }
        }
        const self = yield* loadPackageSelf(id, dir, state);
        if (self)
            return self;
        const folders = [...new Set((request.paths ?? [dir]).flatMap(requireNodeModulePaths))];
        folders.push(...(policy.globalFolders ?? []));
        return yield* loadNodeModules(id, folders, dir, state);
    }
    function* resolve(id, fromDir, request = {}) {
        const state = { configs: new Map() };
        const found = yield* resolvePath(id, fromDir, request, state);
        if (found === null)
            return null;
        if (found instanceof URL)
            return { builtin: found.pathname, scope: null, packageType: null };
        const path = yield* ask.realpath(found);
        const scope = options.collectPackageScope === false ? null : yield* nearestPackageScope(parentDir(path), state);
        return { path, scope, packageType: scope?.type ?? null };
    }
    function* resolveFilePath(path) {
        const found = yield* resolveFile(path, { configs: new Map() }, path.endsWith('/'));
        return found === null ? null : yield* ask.realpath(found);
    }
    function runSync(steps) {
        let next = steps.next();
        while (!next.done) {
            if (next.value instanceof Promise)
                throw new Error('resolveSync: the CommonJS host answered asynchronously');
            next = steps.next(next.value);
        }
        return next.value;
    }
    async function runAsync(steps) {
        let next = steps.next();
        while (!next.done) {
            let answer;
            try {
                answer = await next.value;
            }
            catch (err) {
                next = steps.throw(err);
                continue;
            }
            next = steps.next(answer);
        }
        return next.value;
    }
    return {
        resolve: (id, dir, request) => runAsync(resolve(id, dir, request)),
        resolveSync: (id, dir, request) => runSync(resolve(id, dir, request)),
        resolveFile: (path) => runAsync(resolveFilePath(path)),
        resolveFileSync: (path) => runSync(resolveFilePath(path)),
        packageScope: (dir) => runAsync(nearestPackageScope(dir, { configs: new Map() })),
        packageScopeSync: (dir) => runSync(nearestPackageScope(dir, { configs: new Map() })),
    };
}
// A file's text keeps a leading byte order mark, which TextDecoder's default
// drops: Node's readFileSync returns it, and its parsers (a JSON require, the
// package.json reader: packageJsonText) are what skip it, once.
const cellDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
/**
 * A file's bytes as text, as Node's readFileSync(path, 'utf8') answers them:
 * every byte decoded, a leading byte order mark kept. What
 * RequireFs.readFileString answers, and what a resolver parses.
 */
export function fileText(bytes) {
    return textDecoder.decode(bytes);
}
/**
 * A file's bytes as a module map's cell carries them: its text when the
 * bytes are UTF-8, every byte kept, else the bytes.
 */
export function fileCell(bytes) {
    try {
        return cellDecoder.decode(bytes);
    }
    catch {
        return bytes;
    }
}
/**
 * The text a module walk reads a cell as, or a file's bytes it stages: a
 * text cell is that text; bytes are the file's text (fileText), which is the
 * cell's text when the file is UTF-8 (fileCell). A walk stages, reuses and
 * compares cells through this, in the one representation it reads.
 */
export function heldCellText(cell) {
    return typeof cell === 'string' ? cell : fileText(cell);
}
export function requireFsOverBridge(bridge) {
    const absent = (read) => (async () => {
        try {
            return await read();
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
                return null;
            throw error;
        }
    })();
    const stat = (path) => absent(() => bridge.stat(path));
    const readBytes = (path) => absent(() => bridge.readFile(path));
    return {
        exists: async (path) => (await stat(path)) !== null,
        isDirectory: async (path) => (await stat(path))?.type === 'directory',
        readFileString: async (path) => {
            const bytes = await readBytes(path);
            if (bytes === null)
                throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
            return fileText(bytes);
        },
        stat,
        realpath: (path) => bridge.realpath(path),
        assertReadable: path => bridge.access(path, 4),
        lstat: (path) => absent(() => bridge.stat(path, { followSymlinks: false })),
        readBytes,
    };
}
/** Adapt VFS-relative launch metadata to the algorithm's absolute questions. */
export function requireResolverOverFs(vfs, sink, progress, conditions = [], policy = NIMBUS_TYPESCRIPT_REQUIRE_POLICY) {
    const key = stripLeadingSlashes;
    return createRequireResolver({
        async kind(path) {
            const p = key(path);
            return !(await vfs.exists(p)) ? null : (await vfs.isDirectory(p)) ? 'directory' : 'file';
        },
        async readText(path) {
            const p = key(path);
            if (sink)
                return await sink(p);
            try {
                return await vfs.readFileString(p);
            }
            catch (err) {
                if (codeOf(err) === 'ENOENT')
                    return null;
                throw err;
            }
        },
        realpath: (path) => vfs.realpath ? vfs.realpath(key(path)) : path,
    }, { conditions, policy, progress });
}
/** The launch names reachable files; runtime resolution still reports refusals. */
export function isRequireResolutionError(err) {
    return ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'ERR_PACKAGE_IMPORT_NOT_DEFINED', 'ERR_INVALID_MODULE_SPECIFIER', 'ERR_INVALID_PACKAGE_TARGET',
        'ERR_INVALID_PACKAGE_CONFIG', 'ERR_INVALID_URL_SCHEME', 'ERR_UNKNOWN_BUILTIN_MODULE'].includes(String(codeOf(err)));
}
export async function resolveRequireEx(vfs, id, fromDir, sink, progress, conditions = [], policy = NIMBUS_TYPESCRIPT_REQUIRE_POLICY) {
    try {
        const result = await requireResolverOverFs(vfs, sink, progress, conditions, policy).resolve(id, absolute(fromDir));
        if (!result?.path)
            return null;
        return { resolved: stripLeadingSlashes(result.path), scope: result.scope, packageType: result.packageType };
    }
    catch (err) {
        if (isRequireResolutionError(err))
            return null;
        throw err;
    }
}
export async function resolveFile(vfs, base, sink, progress) {
    try {
        const path = await requireResolverOverFs(vfs, sink, progress).resolveFile(absolute(base));
        return path === null ? null : stripLeadingSlashes(path);
    }
    catch (err) {
        if (isRequireResolutionError(err))
            return null;
        throw err;
    }
}
export async function packageScopeType(vfs, dir, progress) {
    return (await requireResolverOverFs(vfs, undefined, progress).packageScope(absolute(dir)))?.type ?? null;
}
export async function packageJsonVisible(vfs, path) {
    try {
        return await vfs.exists(path);
    }
    catch (err) {
        if (codeOf(err) === 'EACCES')
            return false;
        throw err;
    }
}
/** Node selection by default; speculative builds opt into their named map policy. */
export function requirePackageEntry(pkg, subpath, conditions, buildPolicy) {
    if (buildPolicy)
        return resolvePackageEntry(pkg, subpath, [...DEFAULT_CJS_CONDITIONS, ...conditions], buildPolicy);
    if (pkg.exports == null)
        return subpath === '.' ? pkg.main ?? null : subpath;
    const url = fileUrl('/package.json');
    const policy = createNodePackageMapPolicy(url, '/', false, function* () { throw new Error('An exports target cannot be bare'); });
    const steps = selectPackageMap(pkg.exports, subpath, new Set([...DEFAULT_CJS_CONDITIONS, ...conditions]), policy);
    const next = steps.next();
    if (!next.done)
        throw new Error('Package entry selection must be synchronous');
    return next.value == null ? null : '.' + next.value.pathname + next.value.search + next.value.hash;
}
