/**
 * pre-bundle-facet.ts — the supervisor's half of pre-bundling npm packages
 * (the `Pre-bundling N modules…` step in npm/installer.ts, and the Vite dev
 * server's on-demand /@modules/ bundles).
 *
 * Bundling runs in the Durable Object's build facet (facets/build-facet.ts:
 * `prebundle`, rolldown, core runtime/prebundle-slice.ts), never in the
 * supervisor: a bundle's working set (the engine's wasm memory plus the
 * input and output graph) would not fit beside the supervisor's own heap.
 *
 * File-slice strategy (zero per-read RPC)
 * ──────────────────────────────────────
 * A VFS plugin would naturally call back to the supervisor for every
 * resolve and load. With workerd's ~5–20 ms RPC latency and 50–200 reads
 * per bundle that is seconds of pure RPC overhead per install. Instead the
 * supervisor walks the spec's transitive non-external dependency tree once
 * (fast — direct VFS access) and ships the entire `{path → bytes}` slice as
 * part of the spec; the bundler reads from that in-memory map.
 */
import { getSharedRuntimeExternals } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { packageNameFromSpecifier } from '@nimbus-sh/core/runtime/barrel-detect.js';
// ── Supervisor-side: build the slice for one specifier ──────────────────
/**
 * A file or directory removed (or replaced) between the walk listing it and
 * reading it: the one read failure a walk passes over. Any other (the store
 * unreadable, the session's storage gone) fails the walk, so a slice is never
 * silently missing a file it lists, its entry least of all.
 */
function vanished(error) {
    const code = Reflect.get(Object(error), 'code');
    return code === 'ENOENT' || code === 'ENOTDIR';
}
export function buildSliceForSpecifierWithCap(vfs, specifier, nmDir, capBytes) {
    const externals = new Set();
    for (const e of getSharedRuntimeExternals(specifier)) {
        // strip glob suffix: "react/*" → "react"
        if (e.endsWith('/*'))
            externals.add(e.slice(0, -2));
        else
            externals.add(e);
    }
    const slice = [];
    let totalBytes = 0;
    const visitedPkgs = new Set();
    const addFile = (path) => {
        try {
            if (vfs.isDirectory(path)) {
                slice.push({ path: '/' + path.replace(/^\/+/, ''), isDir: true });
                return true;
            }
            const bytes = vfs.readFile(path);
            totalBytes += bytes.length + path.length;
            if (totalBytes > capBytes)
                return false; // caller bails
            slice.push({ path: '/' + path.replace(/^\/+/, ''), bytes, isDir: false });
            return true;
        }
        catch (error) {
            if (vanished(error))
                return true;
            throw error;
        }
    };
    /**
     * Walk every file under `pkgDir`, depth-limited to keep us out of
     * pathological tarballs (tests have seen 30-deep trees but not 100).
     * Skip nested node_modules — those are dependencies handled separately
     * by the recursive descent below, and including them here would cause
     * double-shipping for many large libraries.
     */
    const walkDir = (dir, depth) => {
        if (depth > 12)
            return true;
        let entries;
        try {
            entries = vfs.readdir(dir);
        }
        catch (error) {
            if (vanished(error))
                return true;
            throw error;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules')
                continue; // handled by dep recursion
            const child = dir + '/' + entry.name;
            if (entry.type === 'directory') {
                if (!addFile(child))
                    return false;
                if (!walkDir(child, depth + 1))
                    return false;
            }
            else {
                if (!addFile(child))
                    return false;
            }
        }
        return true;
    };
    /**
     * Recurse into a package: ship its files, then descend into each
     * non-external `dependencies` entry. Idempotent via visitedPkgs.
     *
     * `isRoot=true` for the FIRST call (the spec's own package). The
     * spec's own package is ALWAYS walked even when its pkgName is also
     * in the externals set — this is required for subpath specs like
     * `react/jsx-runtime` (pkgName = 'react', externals = ['react']).
     * Without this, the slice was empty for jsx-runtime, esbuild got
     * nothing to bundle, the on-demand bundler returned an empty body,
     * and serveModule fell through to the CDN fallback (esm.sh) which
     * shipped a DIFFERENT React instance and broke the dual-React
     * invariant. Verified on prod: jsx-runtime served 178B CDN wrapper
     * instead of a real bundle.
     */
    const visitPkg = (pkgName, isRoot) => {
        if (visitedPkgs.has(pkgName))
            return true;
        visitedPkgs.add(pkgName);
        // External specifiers' files are deliberately omitted (esbuild will
        // mark them external; the bundle leaves the import unresolved for
        // the browser to fetch from /preview/@modules/) — UNLESS this is
        // the spec's own package, which we always need to walk so the
        // entry point and its non-external internals are in the slice.
        if (externals.has(pkgName) && !isRoot)
            return true;
        const pkgDir = nmDir + '/' + pkgName;
        if (!vfs.exists(pkgDir) || !vfs.isDirectory(pkgDir))
            return true;
        if (!addFile(pkgDir))
            return false;
        if (!walkDir(pkgDir, 0))
            return false;
        // Read deps; recurse. Recursion is never `isRoot` — only the
        // outermost spec gets that exemption.
        let pkgJson = null;
        const pkgJsonPath = pkgDir + '/package.json';
        if (vfs.exists(pkgJsonPath)) {
            let text = null;
            try {
                text = vfs.readFileString(pkgJsonPath);
            }
            catch (error) {
                if (!vanished(error))
                    throw error;
            }
            // A manifest that is not JSON names no dependencies.
            try {
                pkgJson = text === null ? null : JSON.parse(text);
            }
            catch { }
        }
        const deps = pkgJson?.dependencies ? Object.keys(pkgJson.dependencies) : [];
        for (const dep of deps) {
            if (!visitPkg(dep, false))
                return false;
        }
        return true;
    };
    const pkgName = packageNameFromSpecifier(specifier);
    if (!visitPkg(pkgName, true)) {
        // Cap exceeded — caller bails out. Empty caller = caller will fall
        // back to legacy in-supervisor path or skip pre-bundling entirely.
        return null;
    }
    return { slice, totalBytes };
}
/**
 * Choose the externals list for a specifier, exported so the supervisor
 * can compute the same value when building the spec without re-pulling
 * the helper from esbuild-service.ts on the call site.
 */
export function externalsForSpecifier(specifier) {
    return getSharedRuntimeExternals(specifier);
}
