/**
 * prebundle-slice.ts — one npm specifier bundled to one browser ES module
 * from a slice of its package files, by any engine with esbuild's build
 * contract (EsbuildBuildHost's shape: esbuild options and a resolve/load
 * plugin). The build facet runs it on rolldown (rolldown-build.ts).
 *
 * The supervisor walks the specifier's transitive, non-external package
 * files once and ships them with the spec (worker npm/pre-bundle-facet.ts,
 * buildSliceForSpecifierWithCap): every resolve and load is answered from
 * that slice, so a pre-bundle makes no call back to the supervisor. Bare
 * specifiers resolve by Node's rules (package.json `exports` with
 * `require` or `import` conditions by the import's kind, `imports` for
 * `#name`, `module`/`main` otherwise); the shared runtime externals
 * (React and its kin) and anything the slice cannot answer stay external,
 * the latter with a warning.
 *
 * Self-contained but for the exports resolver: the build facet's runtime
 * bundles it (scripts/rolldown-facet/entry.mjs).
 */
import { BUNDLER_IMPORT_CONDITIONS, bundlerConditions, createBundlerResolver } from './bundler-resolution.js';
/**
 * What a Vite dev server's modules read of their environment, as Vite's dev
 * values: `process.env.NODE_ENV` so React's CommonJS (and every other
 * package's `NODE_ENV` guard) takes its development branch, and `global` for
 * packages written for Node. `import.meta.env.BASE_URL` is per mount, so not
 * here.
 */
export const VITE_DEV_DEFINE = Object.freeze({
    'import.meta.env.DEV': 'true',
    'import.meta.env.PROD': 'false',
    'import.meta.env.MODE': '"development"',
    'import.meta.env.SSR': 'false',
    'process.env.NODE_ENV': '"development"',
    'global': 'globalThis',
});
/**
 * Every pre-bundle's define, the installer's and the Vite dev server's
 * alike, so either's row is the other's: Vite's dev values, base-neutral
 * (`BASE_URL` is `/`; a bundle is persisted once and served under every
 * mount). A project's vite.config `define` is not in it, as Vite's
 * dependency optimizer applies none of it either.
 */
export const PREBUNDLE_DEFINE = Object.freeze({
    ...VITE_DEV_DEFINE,
    'import.meta.env.BASE_URL': '"/"',
});
/** A pre-bundle's build options, but its entry: what its output is a function of, beside its slice and externals. */
export function prebundleBuildOptions(define) {
    return {
        bundle: true,
        format: 'esm',
        target: 'esnext',
        platform: 'browser',
        conditions: BUNDLER_IMPORT_CONDITIONS,
        mainFields: ['module', 'browser', 'main'],
        define: define && Object.keys(define).length > 0 ? { ...define } : undefined,
    };
}
/** The files a slice holds: everything a bundle built from it can have read. */
export function sliceSources(slice) {
    return slice.flatMap((entry) => (entry.isDir ? [] : [entry.path]));
}
function loaderOf(path) {
    if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts'))
        return 'ts';
    if (path.endsWith('.tsx'))
        return 'tsx';
    if (path.endsWith('.jsx'))
        return 'jsx';
    if (path.endsWith('.json'))
        return 'json';
    if (path.endsWith('.css'))
        return 'css';
    if (path.endsWith('.wasm') || path.endsWith('.node'))
        return 'binary';
    return 'js';
}
const bare = (path) => !path.startsWith('/') && !path.startsWith('.') && !path.startsWith('#');
/** Bundle `spec.specifier` from its slice with `build`. Never throws: a failure is a result. */
export async function prebundleSlice(spec, build) {
    const t0 = Date.now();
    const warnings = [];
    const failed = (errorText) => ({ specifier: spec.specifier, ok: false, esmCode: '', errorText, elapsed: Date.now() - t0, warnings });
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.slice))
        throw new Error('prebundleSlice: the spec has no slice');
    // The slice's files and directories; every file implies its ancestors.
    const norm = (p) => (p.startsWith('/') ? p : '/' + p);
    const files = new Map();
    const dirs = new Set();
    for (const entry of spec.slice) {
        if (entry.isDir)
            dirs.add(norm(entry.path));
        else
            files.set(norm(entry.path), entry.bytes);
    }
    for (const p of files.keys()) {
        for (let slash = p.lastIndexOf('/'); slash > 0; slash = p.lastIndexOf('/', slash - 1))
            dirs.add(p.slice(0, slash));
    }
    const resolver = createBundlerResolver({
        isFile: (p) => files.has(norm(p)),
        isDirectory: (p) => dirs.has(norm(p)),
        readText: (p) => {
            const bytes = files.get(norm(p));
            return bytes ? new TextDecoder().decode(bytes) : null;
        },
    });
    const externalExact = new Set();
    const externalPrefixes = [];
    for (const pattern of spec.externals) {
        if (pattern.endsWith('/*'))
            externalPrefixes.push(pattern.slice(0, -1));
        else
            externalExact.add(pattern);
    }
    const isExternal = (s) => externalExact.has(s) || externalPrefixes.some((prefix) => s.startsWith(prefix));
    const plugin = {
        name: 'nimbus-pre-bundle-slice',
        async resolve(args) {
            const at = (path) => (path ? { path, namespace: 'nimbus-slice' } : null);
            // `#name` first, so it never falls through to external and reaches the browser.
            if (args.path.startsWith('#') && args.resolveDir) {
                const resolved = at(await resolver.resolvePackageImport(args.path, args.resolveDir));
                if (resolved)
                    return resolved;
                warnings.push(`unresolved subpath import "${args.path}" from ${args.importer || '?'} (no owning package.json#imports entry); marked external`);
                return { external: true };
            }
            // Externals are matched here, on bare specifiers only, never on the
            // entry's path: `react/jsx-runtime` externalizes `react` and still
            // bundles its own entry, which esbuild's top-level `external` refused.
            if (bare(args.path) && isExternal(args.path))
                return { external: true };
            if (args.path.startsWith('/')) {
                const resolved = at(await resolver.resolveFile(args.path));
                if (resolved)
                    return resolved;
            }
            if (args.path.startsWith('.') && args.resolveDir) {
                const resolved = at(await resolver.resolveFile(args.resolveDir + '/' + args.path));
                if (resolved)
                    return resolved;
            }
            if (bare(args.path)) {
                const resolved = at(await resolver.resolveBarePackage(args.path, args.resolveDir || '/home/user', bundlerConditions(args.kind)));
                if (resolved)
                    return resolved;
                warnings.push(`unresolved bare import "${args.path}" from ${args.importer || '?'} → marked external`);
            }
            return { external: true };
        },
        async load(args) {
            const bytes = files.get(norm(args.path));
            if (!bytes)
                return { errors: [{ text: 'pre-bundle slice miss: ' + args.path }] };
            const loader = loaderOf(args.path);
            const lastSlash = args.path.lastIndexOf('/');
            const resolveDir = lastSlash > 0 ? args.path.slice(0, lastSlash) : '/';
            return { contents: loader === 'binary' ? bytes : new TextDecoder().decode(bytes), loader, resolveDir };
        },
    };
    // An entry the slice lacks would resolve as external, and the bundler say
    // only "cannot be external": the slice was walked from a store that had
    // lost the package (its session's storage gone, the package removed).
    if (!(await resolver.resolveFile(spec.entryPath))) {
        return failed(`its entry module ${norm(spec.entryPath)} is not in its slice (${files.size} files): the package's files were not there to walk`);
    }
    const outcome = await build({ entryPoints: [norm(spec.entryPath)], ...prebundleBuildOptions(spec.define) }, plugin);
    if (outcome.failure)
        return failed(outcome.errors[0]?.text || outcome.failure);
    const script = outcome.outputFiles.find((file) => !file.path.endsWith('.css')) ?? outcome.outputFiles[0];
    if (!script)
        return failed('no output produced');
    return { specifier: spec.specifier, ok: true, esmCode: new TextDecoder().decode(script.contents), elapsed: Date.now() - t0, warnings };
}
