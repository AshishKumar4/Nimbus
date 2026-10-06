/**
 * bundler-resolution.ts — how Nimbus's bundles resolve a module: the
 * pre-bundle of an npm package (prebundle-slice.ts, over the slice it was
 * handed) and EsbuildService's builds (its VFS plugin, over the session's
 * filesystem). One algorithm over either filesystem, so the two cannot
 * disagree about which file an import names.
 *
 * Bundler policy, not Node's CommonJS one (require-resolution.ts): a file
 * as named, then with each of EXTS appended (TypeScript before JavaScript);
 * a `.js`-family name whose file is not there is tried as its TypeScript
 * twin (moduleResolution "bundler"); then a directory's index. A bare
 * specifier walks up `node_modules`, selecting by `exports` under the
 * import's conditions (`require` for a require call, `import` otherwise, and
 * `browser` either way), then a subpath as a file, then `index`. A `#name`
 * resolves against the `imports` of the nearest package.json alone, as Node
 * and esbuild read it.
 */
import { resolveExports, resolvePackageEntry } from '../_shared/exports-resolver.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { splitBareSpecifier } from './barrel-detect.js';
const BUNDLER_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];
/** A `.js`-family name's TypeScript twins, in the order TypeScript tries them. */
const TYPESCRIPT_TWINS = { js: ['.ts', '.tsx'], jsx: ['.tsx', '.ts'], mjs: ['.mts', '.ts'], cjs: ['.cts', '.ts'] };
/**
 * The conditions for an import of `kind` (esbuild's ImportKind). A require
 * call selects `require`: a package that ships a CommonJS file beside an
 * ESM one for the same export (@babel/runtime/helpers/*, whose ESM file
 * declares only `export { fn as default }`) would otherwise hand a CommonJS
 * caller `{ default: fn }`, and calling what it required crashes.
 */
export function bundlerConditions(kind) {
    return kind === 'require-call' || kind === 'require-resolve' ? BUNDLER_REQUIRE_CONDITIONS : BUNDLER_IMPORT_CONDITIONS;
}
/** The conditions of an import (and a pre-bundle's own build options). */
export const BUNDLER_IMPORT_CONDITIONS = ['import', 'module', 'browser', 'default'];
const BUNDLER_REQUIRE_CONDITIONS = ['require', 'node', 'browser', 'default'];
function* isFile(path) {
    return (yield { op: 'isFile', path }) === true;
}
function* isDirectory(path) {
    return (yield { op: 'isDirectory', path }) === true;
}
function* packageJson(path) {
    if (!(yield* isFile(path)))
        return null;
    const text = yield { op: 'readText', path };
    if (typeof text !== 'string')
        return null;
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
/** The file `base` names, by extension, TypeScript twin, then directory index. */
function* fileSteps(base) {
    const path = '/' + normalizeVfsPath(base);
    for (const ext of BUNDLER_EXTENSIONS)
        if (yield* isFile(path + ext))
            return path + ext;
    const named = /\.(js|mjs|cjs|jsx)$/.exec(path);
    if (named) {
        const stem = path.slice(0, path.length - named[0].length);
        for (const ext of TYPESCRIPT_TWINS[named[1]])
            if (yield* isFile(stem + ext))
                return stem + ext;
    }
    if (yield* isDirectory(path)) {
        for (const index of INDEX_FILES)
            if (yield* isFile(path + '/' + index))
                return path + '/' + index;
    }
    return null;
}
/** `/`-rooted `dir` and each directory above it, the root excluded. */
function* ancestors(dir) {
    for (let at = normalizeVfsPath(dir); at; at = at.slice(0, Math.max(0, at.lastIndexOf('/'))))
        yield '/' + at;
}
/** A `#name` from a module in `fromDir`. */
function* packageImportSteps(specifier, fromDir) {
    for (const dir of ancestors(fromDir)) {
        if (!(yield* isFile(dir + '/package.json')))
            continue;
        const pkg = yield* packageJson(dir + '/package.json');
        const target = pkg?.imports ? resolveExports(pkg.imports, specifier) : null;
        return target ? yield* fileSteps(dir + '/' + target.replace(/^\.\//, '')) : null;
    }
    return null;
}
/** A bare specifier from a module in `fromDir`. */
function* barePackageSteps(specifier, fromDir, conditions) {
    const { name, subpath } = splitBareSpecifier(specifier);
    for (const dir of ancestors(fromDir)) {
        const packageDir = dir + '/node_modules/' + name;
        if (!(yield* isDirectory(packageDir)))
            continue;
        const pkg = yield* packageJson(packageDir + '/package.json');
        const entry = pkg ? resolvePackageEntry(pkg, subpath ? './' + subpath : '.', conditions) : null;
        const resolved = (entry && (yield* fileSteps(packageDir + '/' + entry.replace(/^\.\//, ''))))
            || (subpath && (yield* fileSteps(packageDir + '/' + subpath)))
            || (yield* fileSteps(packageDir + '/index'));
        if (resolved)
            return resolved;
    }
    return null;
}
/**
 * The resolutions over a synchronous filesystem, answered synchronously.
 * A pre-bundle's slice plugin resolves this way, in the build facet: its
 * rolldown hook gets a promise that is already settled, as it did before
 * the resolution was shared. Driven asynchronously instead, the deployed
 * facet's pre-bundles stopped settling (frameworks/markflow-real) though
 * every one built under the local harness.
 */
export function createSyncBundlerResolver(fs) {
    const run = (steps) => {
        let step = steps.next();
        while (!step.done)
            step = steps.next(fs[step.value.op](step.value.path));
        return step.value;
    };
    return {
        resolveFile: (base) => run(fileSteps(base)),
        resolvePackageImport: (specifier, fromDir) => run(packageImportSteps(specifier, fromDir)),
        resolveBarePackage: (specifier, fromDir, conditions) => run(barePackageSteps(specifier, fromDir, conditions)),
    };
}
/** The resolutions over a filesystem that may answer later (the session VFS). */
export function createBundlerResolver(fs) {
    const run = async (steps) => {
        let step = steps.next();
        while (!step.done)
            step = steps.next(await fs[step.value.op](step.value.path));
        return step.value;
    };
    return {
        resolveFile: (base) => run(fileSteps(base)),
        resolvePackageImport: (specifier, fromDir) => run(packageImportSteps(specifier, fromDir)),
        resolveBarePackage: (specifier, fromDir, conditions) => run(barePackageSteps(specifier, fromDir, conditions)),
    };
}
