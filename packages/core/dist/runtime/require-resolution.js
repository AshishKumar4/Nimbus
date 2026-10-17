import { codeOf, createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, resolvePackageEntry, selectPackageMap, } from '../_shared/exports-resolver.js';
import { absolute, createRequireResolver, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, } from '../_shared/commonjs-resolver.js';
import { SafeSet } from '../_shared/primordials.js';
import { stripLeadingSlashes } from '../vfs/path.js';
export { createRequireResolver, METADATA_CANDIDATE_WORK, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, NODE_REQUIRE_POLICY, requireNodeModulePaths, } from '../_shared/commonjs-resolver.js';
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
    const url = new URL('file:///package.json');
    const policy = createNodePackageMapPolicy(url, '/', false, function* () { throw new Error('An exports target cannot be bare'); });
    const steps = selectPackageMap(pkg.exports, subpath, new SafeSet([...DEFAULT_CJS_CONDITIONS, ...conditions]), policy);
    const next = steps.next();
    if (!next.done)
        throw new Error('Package entry selection must be synchronous');
    return next.value == null ? null : '.' + next.value.pathname + next.value.search + next.value.hash;
}
