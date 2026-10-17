/**
 * npm/browser-prebundle.ts — a bare specifier's browser bundle (Vite's
 * dependency pre-bundle), one path for the installer's warming and the dev
 * server's /@modules requests.
 *
 * A specifier is bundled from its package's entry (resolvePrebundleEntry),
 * or, for a barrel package imported whole, from an entry synthesized from
 * the names the project imports of it (runtime/barrel-synthesizer.ts). The
 * build runs in the session's build facet from a slice the supervisor walks
 * under the shared allocation budget, or, with no pool and where the caller
 * allows it, by the EsbuildService's build. A bundle is keyed by what built
 * it and the manifests it read (cache-keys.ts) and stored raw, the same row
 * for both callers, when those manifests are still current. A stored row
 * answers a request whose barrel input it was built for, whose sources the
 * principal may read, and whose key the code serving now would give it.
 */
import { getSharedRuntimeExternals, vfsBuildInputs } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { countPackageFiles, BARREL_PKG_FILE_THRESHOLD, packageNameFromSpecifier, splitBareSpecifier } from '@nimbus-sh/core/runtime/barrel-detect.js';
import { PREBUNDLE_DEFINE } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import { R_OK } from '@nimbus-sh/core/runtime/process-files.js';
import { recallOf } from '@nimbus-sh/core/vfs/recall.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { parseResolvablePackageJson, resolvePackageEntry } from '@nimbus-sh/core/_shared/exports-resolver.js';
import { PRE_BUNDLE_SLICE_CAP_BYTES } from '@nimbus-sh/platform/limits.js';
import { describeError } from '@nimbus-sh/platform/oom-classify.js';
import { discoverScopedSliceForSynthetic, buildSyntheticEntry, namedImportSignature, scanProjectImports, syntheticEntryPath, PROJECT_SCAN, } from '../runtime/barrel-synthesizer.js';
import { manifestsOf, prebundleCacheKey, prebundleRequest, recordingManifests, serviceBuildCacheKey, stillCurrent, } from './cache-keys.js';
import { planSliceForSpecifierWithCap, planSliceFromPaths, materializePrebundleSlice, PrebundleInputs, PrebundlePlanChanged } from './pre-bundle-facet.js';
/**
 * The options a pre-bundle is built with through the service's build(), the
 * path with no bundle pool: the pooled build's define.
 */
const SERVICE_PREBUNDLE_OPTIONS = Object.freeze({
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    define: PREBUNDLE_DEFINE,
});
/** The barrel package `specifier` names whole, or null (a subpath, or a package of few files). */
export function barrelPackage(ctx, specifier) {
    const pkgName = packageNameFromSpecifier(specifier);
    if (specifier !== pkgName)
        return null;
    const fileCount = countPackageFiles(ctx.vfs, ctx.root + '/node_modules/' + pkgName);
    return fileCount > BARREL_PKG_FILE_THRESHOLD ? { pkgName, fileCount } : null;
}
/**
 * The barrel input of a request for `barrel` from the project's imports,
 * or null where the scan left files unread (an entry from what it found
 * could miss a name), which `unread` reports: the barrel is bundled whole.
 */
export function barrelInput(barrel, scan, unread) {
    const { pkgName, fileCount } = barrel;
    if (scan.unread !== null) {
        unread?.(pkgName, fileCount, scan.unread);
        return null;
    }
    const names = scan.namedImports.get(pkgName) ?? null;
    return { pkgName, fileCount, names, inputHash: namedImportSignature(pkgName, names) ?? '' };
}
/** The project's imports, within PROJECT_SCAN, as both callers scan them. */
export function scanProject(ctx) {
    return scanProjectImports(ctx.vfs, ctx.root, ctx.parse, PROJECT_SCAN);
}
/**
 * Whether a bundle stored with `inputHash` answers a request with `barrel`:
 * one synthesized from some names answers only a barrel request for those
 * names; any other request takes only a whole bundle.
 */
export function answersBarrel(inputHash, barrel) {
    if (!barrel)
        return !inputHash;
    return !!barrel.inputHash && inputHash === barrel.inputHash;
}
/** `path`'s text in the principal's view, or null. */
function readText(ctx, path) {
    try {
        return ctx.vfs.readFileString(path);
    }
    catch {
        return null;
    }
}
function mayRead(ctx, path) {
    try {
        ctx.vfs.access(path, R_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The stored bundle of `specifier` that answers this request: built for its
 * barrel input, from sources the principal may all read (one that names
 * none is never served), keyed as the code serving now keys this request
 * from those manifests as they read now (by the facet, or by the service).
 * Null at once where no row can answer; else the key check's answer.
 */
export function storedPrebundle(ctx, specifier, barrel) {
    const row = ctx.cache?.getEsmBundle(specifier);
    if (!row || !answersBarrel(row.inputHash, barrel) || row.sources.length === 0)
        return null;
    if (!row.sources.every((path) => mayRead(ctx, path)))
        return null;
    const request = prebundleRequest(specifier, manifestsOf(row.sources, (path) => readText(ctx, path)));
    return Promise.all([
        prebundleCacheKey(request),
        serviceBuildCacheKey(ctx.esbuild.transformHostId, { ...request, options: SERVICE_PREBUNDLE_OPTIONS }),
    ]).then((keys) => (keys.includes(row.bundleHash) ? { esmCode: row.esmCode, inputHash: row.inputHash ?? '' } : null));
}
/**
 * Build `specifier`'s bundle for a request with `barrel`, store it when the
 * manifests it was built from are still current, and give it to `serve`
 * after its input slice has been handed to the facet and dropped here.
 */
export async function buildPrebundle(ctx, specifier, barrel, serve) {
    ctx = { ...ctx };
    for (let changedPlans = 0;; changedPlans++) {
        ctx.signal?.throwIfAborted();
        const inputs = new PrebundleInputs(ctx.vfs);
        const resolved = resolvePrebundleEntry(inputs.fs, ctx.root, specifier);
        if (!resolved)
            return { kind: 'unresolved' };
        // A module its principal may not read is refused (its EACCES), not bundled from a partial package.
        inputs.fs.access(resolved, R_OK);
        if (/\.(wasm|node)$/i.test(resolved)) {
            return { kind: 'refused', status: 'native', message: `its entry ${resolved} is a native or WebAssembly payload, not JavaScript`, names: new Set() };
        }
        const entry = barrel ? synthesizeEntry(ctx, inputs.fs, specifier, barrel) : { entryPath: resolved, referencedFiles: null };
        if ('kind' in entry)
            return entry;
        const pool = await acquirePool(ctx);
        if (pool === null && !ctx.serviceFallback)
            return { kind: 'unavailable', message: 'the session has no build facet pool' };
        if (typeof pool === 'string' && !ctx.serviceFallback)
            return { kind: 'unavailable', message: pool };
        let built;
        try {
            built = pool !== null && typeof pool !== 'string'
                ? await buildInFacet(ctx, pool, specifier, entry, inputs)
                : await buildInService(ctx, specifier, entry.entryPath, inputs);
        }
        catch (error) {
            ctx.signal?.throwIfAborted();
            if (recallOf(error) !== null || ['EACCES', 'EPERM'].includes(Reflect.get(Object(error), 'code')))
                throw error;
            // A changed plan invalidates entry resolution AND synthesis, not only its slice.
            if (error instanceof PrebundlePlanChanged && changedPlans === 0)
                continue;
            return { kind: 'failed', message: describeError(error) };
        }
        if (typeof built === 'string')
            return { kind: 'failed', message: built };
        const inputHash = barrel?.inputHash ?? '';
        ctx.signal?.throwIfAborted();
        const changed = built.moved || !await built.current();
        let storeFailure = null;
        if (ctx.cache && built.sources.length > 0 && !changed) {
            try {
                ctx.cache.putEsmBundle({ specifier, bundleHash: built.key, esmCode: built.esmCode, builtAt: Date.now(), inputHash, sources: built.sources });
            }
            catch (error) {
                storeFailure = describeError(error);
            }
        }
        return { kind: 'built', served: serve(built.esmCode), inputHash, changed, storeFailure, warnings: built.warnings };
    }
}
/** The session's pool, null for none, or why it could not be had. */
async function acquirePool(ctx) {
    if (!ctx.pool)
        return null;
    try {
        return await ctx.pool.acquire(ctx.signal);
    }
    catch (error) {
        ctx.signal?.throwIfAborted();
        return `the build facet pool could not be acquired: ${describeError(error)}`;
    }
}
/**
 * The entry a barrel request is bundled from: one re-exporting the names
 * the project imports, written beside node_modules, and the package files
 * it references; or why there is none.
 */
function synthesizeEntry(ctx, fs, specifier, barrel) {
    const { pkgName, fileCount, names } = barrel;
    if (!names || names.size === 0) {
        return {
            kind: 'refused',
            status: 'no-static-imports',
            message: `cannot bundle ${specifier}: barrel package (${fileCount} files) with no static named imports detected in user source. `
                + `Dynamic imports / computed-name access can't be tree-shaken. Add explicit imports like `
                + `\`import { IconName } from '${pkgName}'\` so Nimbus can synthesize a tree-shakable entry.`,
            names: new Set(),
        };
    }
    const synth = buildSyntheticEntry(fs, ctx.root + '/node_modules', pkgName, names);
    if (!synth) {
        return {
            kind: 'refused',
            status: 'synth-null',
            message: `synthetic entry generation failed for ${specifier} (barrel: ${fileCount} files; ${names.size} static imports). `
                + `The package's index does not parse as JavaScript, or re-exports none of the imported names from its own modules (export {…} from, export * from, export * as). File a bug.`,
            names,
        };
    }
    const entryPath = syntheticEntryPath(ctx.root, pkgName);
    try {
        ctx.vfs.mkdir(entryPath.substring(0, entryPath.lastIndexOf('/')), { recursive: true });
        ctx.vfs.writeFile(entryPath, synth.code);
    }
    catch (error) {
        return { kind: 'refused', status: 'vfs-write-failed', message: `failed to write synthetic entry for ${specifier}: ${describeError(error)}`, names };
    }
    return { entryPath, referencedFiles: synth.referencedFiles };
}
/** The bundle built in the facet from a slice walked here, or why not. */
async function buildInFacet(ctx, pool, specifier, entry, inputs) {
    ctx.signal?.throwIfAborted();
    const prepared = await discoverSlice(ctx, specifier, entry, inputs);
    if (!prepared)
        return `its files exceed the ${(PRE_BUNDLE_SLICE_CAP_BYTES / (1024 * 1024)).toFixed(0)} MiB a bundle may be built from`;
    const { plan, sources, key, externals } = prepared;
    const result = await pool.prebundle({
        specifier, signal: ctx.signal, bytes: plan.allocationBytes, running: ctx.running,
        owner: { owner: `prebundle '${specifier}'`, ...ctx.owner },
        prepare: () => {
            ctx.signal?.throwIfAborted();
            const slice = materializePrebundleSlice(ctx.vfs, plan);
            return { specifier, entryPath: entry.entryPath, externals, slice, bundlerVersion: key, define: PREBUNDLE_DEFINE };
        },
    });
    if (!result.ok || !result.esmCode)
        return `its bundle failed: ${result.errorText ?? 'no output'}`;
    return {
        esmCode: result.esmCode, sources, key, moved: false, warnings: result.warnings ?? [],
        current: () => inputs.current(),
    };
}
/** Resolve and parse first. Parser input is its own transient, not a retained slice. */
async function discoverSlice(ctx, specifier, entry, inputs) {
    const nmDir = ctx.root + '/node_modules';
    let plan;
    if (entry.referencedFiles !== null) {
        const paths = await discoverScopedSliceForSynthetic(inputs.fs, nmDir, packageNameFromSpecifier(specifier), entry.referencedFiles, ctx.parse);
        paths.push({ path: entry.entryPath.substring(0, entry.entryPath.lastIndexOf('/')), isDir: true });
        paths.push({ path: entry.entryPath, isDir: false });
        plan = planSliceFromPaths(ctx.vfs, paths, PRE_BUNDLE_SLICE_CAP_BYTES, inputs);
    }
    else
        plan = planSliceForSpecifierWithCap(ctx.vfs, specifier, nmDir, PRE_BUNDLE_SLICE_CAP_BYTES, inputs);
    if (plan === null)
        return null;
    const sources = plan.entries.filter((item) => !item.isDir).map((item) => item.slicePath);
    const request = prebundleRequest(specifier, manifestsOf(sources, (path) => {
        try {
            return inputs.fs.readFileString(path);
        }
        catch {
            return null;
        }
    }));
    const key = await prebundleCacheKey(request);
    if (!inputs.current())
        throw new PrebundlePlanChanged();
    return { plan, sources, key, externals: [...request.externals] };
}
/** The bundle built by the EsbuildService's build (no pool), reading through a view that records each manifest as it reads it. */
async function buildInService(ctx, specifier, entryPath, inputs) {
    const recording = recordingManifests((path) => readText(ctx, path));
    const vfs = inputs.fs;
    const fs = {
        exists: (path) => vfs.exists(path),
        isDirectory: (path) => vfs.isDirectory(path),
        readFile: (path) => {
            const bytes = vfs.readFile(path);
            recording.saw(path, path.endsWith('/package.json') ? new TextDecoder().decode(bytes) : undefined);
            return bytes;
        },
        readFileString: (path) => {
            const text = vfs.readFileString(path);
            recording.saw(path, text);
            return text;
        },
    };
    const externals = getSharedRuntimeExternals(specifier);
    try {
        const result = await ctx.esbuild.build([entryPath], {
            ...SERVICE_PREBUNDLE_OPTIONS,
            define: { ...SERVICE_PREBUNDLE_OPTIONS.define },
            external: externals.length > 0 ? externals : undefined,
            fs,
        });
        if (!result.outputFiles?.length)
            return 'its bundle produced no output';
        const sources = vfsBuildInputs(result.metafile);
        const manifests = recording.manifests(sources);
        const key = await serviceBuildCacheKey(ctx.esbuild.transformHostId, { ...prebundleRequest(specifier, manifests), options: SERVICE_PREBUNDLE_OPTIONS });
        return { esmCode: result.outputFiles[0].contents, sources, key, current: () => inputs.current() && stillCurrent(manifests, (path) => readText(ctx, path)), moved: recording.moved(), warnings: [] };
    }
    catch (error) {
        return describeError(error);
    }
}
/** Packages that run in Vite's server, never in a browser: the installer does not warm them. */
export function isServerToolPackage(pkgName) {
    if (pkgName === '@tailwindcss/vite' || pkgName === '@tailwindcss/postcss')
        return true;
    if (pkgName === 'postcss' || pkgName === 'autoprefixer' || pkgName === 'cssnano')
        return true;
    if (pkgName === 'lightningcss' || pkgName === 'esbuild' || pkgName === 'esbuild-wasm')
        return true;
    return pkgName.startsWith('@vitejs/plugin-') || pkgName.startsWith('vite-plugin-') || pkgName.startsWith('postcss-')
        || pkgName.startsWith('@rollup/plugin-') || pkgName.startsWith('rollup-plugin-');
}
/**
 * The file a bare specifier (with a subpath or not) is bundled from, under
 * the first of the project's, the user's and the system's node_modules that
 * has its package:
 *   1. its package's exports, for the subpath, with the browser conditions;
 *   2. a subpath as a file or a directory index, or a directory with its own
 *      package.json (module, main);
 *   3. the root's module or main field;
 *   4. the package's index.
 * Paths are normalized: a nested package.json may point out of its directory.
 */
export function resolvePrebundleEntry(vfs, root, specifier) {
    const { name: pkgName, subpath } = splitBareSpecifier(specifier);
    for (const dir of [root, 'home/user', 'usr/share/pkg']) {
        const pkgDir = dir + '/node_modules/' + pkgName;
        if (!vfs.exists(pkgDir))
            continue;
        let pkg = null;
        if (vfs.exists(pkgDir + '/package.json')) {
            try {
                pkg = parseResolvablePackageJson(vfs.readFileString(pkgDir + '/package.json'));
            }
            catch { /* unreadable */ }
        }
        if (pkg?.exports) {
            const entry = resolvePackageEntry(pkg, subpath ? './' + subpath : '.');
            const found = entry ? resolveFile(vfs, normalizeVfsPath(pkgDir + '/' + entry.replace(/^\.\//, ''))) : null;
            if (found)
                return found;
        }
        if (subpath) {
            const direct = resolveFile(vfs, normalizeVfsPath(pkgDir + '/' + subpath));
            if (direct)
                return direct;
            const nestedPath = pkgDir + '/' + subpath + '/package.json';
            if (vfs.exists(nestedPath)) {
                let nested = null;
                try {
                    nested = parseResolvablePackageJson(vfs.readFileString(nestedPath));
                }
                catch { /* unreadable */ }
                if (nested !== null) {
                    const entry = nested.module || nested.main || 'index.js';
                    const found = resolveFile(vfs, normalizeVfsPath(pkgDir + '/' + subpath + '/' + entry.replace(/^\.\//, '')));
                    if (found)
                        return found;
                }
            }
        }
        if (!subpath && pkg) {
            const entry = pkg.module || pkg.main;
            const found = entry ? resolveFile(vfs, normalizeVfsPath(pkgDir + '/' + entry.replace(/^\.\//, ''))) : null;
            if (found)
                return found;
        }
        const index = resolveFile(vfs, pkgDir + '/index');
        if (index)
            return index;
    }
    return null;
}
/** `base` as a file, with the extensions packages ship, or as a directory's index. */
function resolveFile(vfs, base) {
    const norm = normalizeVfsPath(base);
    for (const ext of ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json']) {
        const path = norm + ext;
        if (vfs.exists(path) && !vfs.isDirectory(path))
            return path;
    }
    if (vfs.exists(norm) && vfs.isDirectory(norm)) {
        for (const index of ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx']) {
            const path = norm + '/' + index;
            if (vfs.exists(path) && !vfs.isDirectory(path))
                return path;
        }
    }
    return null;
}
