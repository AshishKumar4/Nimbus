/**
 * pre-bundle-facet.ts — NimbusLoaderPool entry for esbuild pre-bundling.
 *
 * Why this exists
 * ───────────────
 * Pre-bundling npm packages (the `Pre-bundling N modules…` step in
 * src/npm-installer.ts:704) used to call `EsbuildService.build(...)`
 * inside the supervisor DO isolate. Each `esbuild.build` allocates
 * 30–80 MiB of WASM linear memory plus the input/output graph; against
 * the 128 MB DO heap cap this OOM-killed the supervisor on installs
 * touching large React libraries (motion, framer-motion, etc.). The
 * symptom was a banner re-print after `npm install` succeeded —
 * NimbusSession's constructor running again because workerd had killed
 * the previous isolate.
 *
 * The fix is to dispatch each per-specifier `esbuild.build` to a
 * NimbusLoaderPool isolate. Each facet has its own 128 MB budget and
 * stable-slot reuse keeps the warm-up cost amortized across the 8
 * concurrent specs of a typical install. The install-batch facet uses
 * the same isolate boundary for tarball extraction.
 *
 * File-slice strategy (zero per-read RPC)
 * ──────────────────────────────────────
 * esbuild's VFS plugin would naturally call back to the supervisor for
 * every onLoad / onResolve hit. With workerd's ~5–20 ms RPC latency and
 * 50–200 reads per bundle × 8 specs that's 4–32 seconds of pure RPC
 * overhead per install — measurably worse than the current OOM-y path.
 *
 * Instead the supervisor walks the spec's transitive non-external
 * dependency tree once (fast — direct VFS access) and ships the
 * entire `{path → bytes}` slice as part of the spec. The facet's VFS
 * plugin reads from this in-memory map. Zero RPC during bundling.
 *
 * Stability invariants
 * ───────────────────
 * cloudflare-parallel serializes the function via `fn.toString()`.
 *   - No `this` references (arrow / anonymous async).
 *   - No free variables other than preamble names + explicit args.
 *   - Module-level constants the function references must come from
 *     the preamble (src/loaders/pre-bundle-preamble.ts) — see
 *     `ESBUILD_PRELOAD_PREAMBLE`.
 *
 * The supervisor RPC surface (env.SUPERVISOR) is available for emergency
 * fallbacks but the bundle path MUST NOT use it — slice-up-front is the
 * contract.
 */
import { getSharedRuntimeExternals, BUNDLER_VERSION } from '@nimbus-sh/core/runtime/esbuild-service.js';
export function buildSliceForSpecifier(vfs, specifier, nmDir) {
    return buildSliceForSpecifierWithCap(vfs, specifier, nmDir, 24 * 1024 * 1024);
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
    // Bare-specifier → top-level package name (handles @scope/pkg).
    const pkgNameFor = (spec) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
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
        catch {
            return true; /* skip unreadable */
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
        catch {
            return true;
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
            try {
                pkgJson = JSON.parse(vfs.readFileString(pkgJsonPath));
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
    const pkgName = pkgNameFor(specifier);
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
// ── Facet function ──────────────────────────────────────────────────────
//
// `prebundleOne` runs inside a NimbusLoaderPool isolate. cloudflare-parallel
// serialises it via fn.toString(); the helpers it references at module
// scope (ESBUILD_WASM_JS_FN_BODY, resolvePackageEntry) are NOT in the
// facet's lexical scope at runtime. Instead they're injected by the
// pre-bundle preamble; see src/loaders/pre-bundle-preamble.ts.
//
// The wasm BYTES are NOT in the preamble (intentionally — that was a
// 16 MiB allocation per dispatch which OOM'd the DO). They live in
// env.ASSETS, the supervisor fetches once at pool construction
// (src/esbuild-wasm-bytes.ts), and the bytes flow into the facet via
// the LOADER `modules` map. workerd compiles at facet module-load
// (startup phase, eval permitted) and exposes the resulting
// WebAssembly.Module via the standard ESM import the pool's
// generated worker.js performs.
/**
 * Bundle one specifier in a facet isolate. Returns the ESM bundle output
 * to the supervisor; bundle bytes flow through `pool.map`'s return value
 * (no RPC writeBatch — pkg_esm_bundles is supervisor-side SQLite, not VFS).
 *
 * Memory plan (verified by /api/_diag/memory after the rollout):
 *   - Slice retained in facet memory: ~3–10 MiB per typical React lib.
 *   - esbuild WASM linear memory: ~30–80 MiB during build.
 *   - Output bundle: usually <2 MiB.
 *   - Peak in the facet: ~100 MiB worst case (well under 128 MB cap).
 *
 * The supervisor never holds more than the spec arg + result return at
 * once, so its peak stays in the low tens of MiB during the entire
 * pre-bundle phase.
 */
export const prebundleOne = async function prebundleOne(spec, _env) {
    const t0 = Date.now();
    const warnings = [];
    if (!spec || typeof spec !== 'object') {
        throw new Error('prebundleOne: missing spec');
    }
    if (!Array.isArray(spec.slice)) {
        throw new Error('prebundleOne: spec.slice missing');
    }
    // 1. Build an in-memory slice index. Path → bytes for files, set
    //    membership for directories. esbuild's plugin will look up paths
    //    here exactly the way it would have looked them up in the VFS.
    const fileMap = new Map();
    const dirSet = new Set();
    const norm = (p) => p.startsWith('/') ? p : '/' + p;
    for (const ent of spec.slice) {
        if (ent.isDir)
            dirSet.add(norm(ent.path));
        else
            fileMap.set(norm(ent.path), ent.bytes);
    }
    // Every file path implicitly creates its ancestor dirs in the slice's
    // worldview, even if the supervisor walker didn't emit them.
    for (const p of fileMap.keys()) {
        let d = p;
        while (d.length > 1) {
            const slash = d.lastIndexOf('/');
            if (slash <= 0)
                break;
            d = d.substring(0, slash);
            dirSet.add(d);
        }
    }
    // 2. Pick up the esbuild namespace materialised by the preamble at
    //    module startup. workerd's deployed config disallows "Code
    //    generation from strings" at REQUEST time inside dynamic workers,
    //    so we cannot run `new Function(jsBody)()` here. The preamble
    //    runs that at module-load time (where eval is permitted) and
    //    stashes the result on the module-scope const __NIMBUS_ESBUILD_NS.
    //
    //    The WASM module is shipped into the facet via NimbusLoaderPool's
    //    `wasmModules` option, registered in the LOADER's modules map as
    //    { wasm: ArrayBuffer }. Workerd compiles it during the worker's
    //    module-load phase (eval permitted there), and the pool's
    //    generated worker.js exposes the resulting WebAssembly.Module on
    //    globalThis.__NIMBUS_WASM[<key>]. We read it here at request time
    //    — no RPC, no compile, no structured-clone of Module values.
    //
    //    First-dispatch costs (per warm slot):
    //      - 0 (esb namespace materialised at startup)
    //      - 0 (wasm Module already compiled by workerd at startup)
    //      - esb.initialize (~10 ms)
    //    Subsequent dispatches: pure cache hit.
    // @ts-ignore — preamble symbol.
    const esbInitErr = __NIMBUS_ESBUILD_INIT_ERR;
    if (esbInitErr) {
        throw new Error(`prebundleOne: esbuild namespace unavailable (preamble eval failed: ${esbInitErr})`);
    }
    // @ts-ignore — preamble symbol.
    const esb = __NIMBUS_ESBUILD_NS;
    if (!esb) {
        throw new Error('prebundleOne: __NIMBUS_ESBUILD_NS is null (preamble did not run?)');
    }
    // Initialize esbuild's wasm exactly once per facet isolate. With
    // pool concurrency > 1, multiple dispatches may run concurrently in
    // the same slot — without an in-flight promise gate, both observe
    // `!ready`, both call esb.initialize, the second errors with
    // "You need to wait for the promise returned from 'initialize' to
    // be resolved before calling this." Cache the in-flight Promise so
    // concurrent callers await the same init; resolved Promise is
    // cheap to await on subsequent dispatches.
    let initPromise = globalThis.__nimbusFacetEsbuildInit;
    if (!initPromise) {
        initPromise = (async () => {
            // Read the WebAssembly.Module the pool registered. The key matches
            // the name passed to NimbusLoaderPool's `wasmModules` option (see
            // src/npm-installer.ts:prebundleUsedModules dispatch site).
            const wasmRegistry = globalThis.__NIMBUS_WASM;
            const wasmModule = wasmRegistry && wasmRegistry['esbuild.wasm'];
            if (!wasmModule) {
                throw new Error(`prebundleOne: globalThis.__NIMBUS_WASM['esbuild.wasm'] missing — ` +
                    `pool was constructed without wasmModules?`);
            }
            try {
                await esb.initialize({ wasmModule, worker: false });
            }
            catch (e) {
                // "more than once" is harmless — this isolate already initialized
                // in a previous warm dispatch; treat as success.
                if (!String(e?.message || '').includes('more than once'))
                    throw e;
            }
        })();
        globalThis.__nimbusFacetEsbuildInit = initPromise;
    }
    await initPromise;
    // 3. Build the VFS plugin. The plugin reads from `fileMap` exclusively;
    //    every miss is logged into `warnings` so the supervisor can see
    //    whether the slice walker is missing something the bundle path
    //    actually wanted.
    const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
    const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];
    const stripLeadingSlash = (p) => p.replace(/^\/+/, '');
    const normalizePath = (p) => {
        // Resolve any `..` segments to keep tryResolve's exists() lookups
        // canonical. This helper runs inside the serialized facet function,
        // so it mirrors src/vfs/path.ts instead of importing it.
        const parts = p.split('/');
        const out = [];
        for (const seg of parts) {
            if (seg === '' || seg === '.')
                continue;
            if (seg === '..') {
                if (out.length > 0)
                    out.pop();
                continue;
            }
            out.push(seg);
        }
        return (p.startsWith('/') ? '/' : '') + out.join('/');
    };
    const fileExists = (p) => fileMap.has(norm(p));
    const dirExists = (p) => dirSet.has(norm(p));
    const tryResolve = (base) => {
        const n = normalizePath(base);
        for (const ext of EXTS) {
            const cand = n + ext;
            if (fileExists(cand))
                return cand;
        }
        // Bundler-style swap: import './x.js' → ./x.ts on disk.
        const m = n.match(/\.(js|mjs|cjs|jsx)$/);
        if (m) {
            const without = n.slice(0, n.length - m[0].length);
            const swapMap = {
                js: ['.ts', '.tsx'], jsx: ['.tsx', '.ts'],
                mjs: ['.mts', '.ts'], cjs: ['.cts', '.ts'],
            };
            for (const ext of swapMap[m[1]] || []) {
                const cand = without + ext;
                if (fileExists(cand))
                    return cand;
            }
        }
        if (dirExists(n)) {
            for (const idx of INDEX_FILES) {
                const cand = n + '/' + idx;
                if (fileExists(cand))
                    return cand;
            }
        }
        return null;
    };
    // Subpath imports (`#X`) → resolve via the importing module's owning
    // package.json `imports` field. Walks up from `fromDir` looking for
    // package.json; first one with `#X` in its `imports` map wins.
    // Reuses `resolveExports` (provided by the pre-bundle preamble) since
    // imports/exports share the same shape (subpath → conditions →
    // target).
    //
    // This is the slice-path counterpart to esbuild-service.ts's
    // `resolvePackageImport` (which serves the supervisor's in-process
    // bundler). Both must walk up only as far as the first package.json —
    // Node's spec is "imports field of the importing module's package",
    // never the parent's.
    //
    // Without this, packages like vfile / unified / remark / mdx (heavy
    // users of `#minpath` / `#minurl` / `#minproc`) leak literal `#X`
    // specifiers into the bundle output, and the browser then chokes
    // with `Failed to resolve module specifier "#minpath"`. Fix: resolve
    // here so the bundle output references the actual file path.
    const resolvePackageImport = (specifier, fromDir) => {
        let dir = stripLeadingSlash(fromDir);
        const visited = new Set();
        while (dir && !visited.has(dir)) {
            visited.add(dir);
            const pkgJsonPath = '/' + dir + '/package.json';
            if (fileExists(pkgJsonPath)) {
                try {
                    const pkgJsonText = new TextDecoder().decode(fileMap.get(norm(pkgJsonPath)));
                    const pkgJson = JSON.parse(pkgJsonText);
                    if (pkgJson && pkgJson.imports) {
                        // @ts-ignore — preamble symbol.
                        const target = resolveExports(pkgJson.imports, specifier);
                        if (target) {
                            const r = tryResolve('/' + dir + '/' + target.replace(/^\.\//, ''));
                            if (r)
                                return r;
                        }
                    }
                }
                catch { /* malformed package.json — keep walking */ }
                // First package.json wins regardless of whether it had `imports`
                // (Node spec). Stop here even on a miss.
                return null;
            }
            const lastSlash = dir.lastIndexOf('/');
            if (lastSlash <= 0)
                break;
            dir = dir.substring(0, lastSlash);
        }
        return null;
    };
    // Conditions per-resolution. CJS `require('X')` callers need the
    // `require` condition selected so packages that ship a dual-export
    // CJS trick (e.g. @babel/runtime/helpers/X — `module.exports = fn;
    // module.exports.default = module.exports;`) resolve to the CJS
    // file. The ESM helper file (`./helpers/esm/X.js`) declares only
    // `export { fn as default }`, which esbuild's __toCommonJS wrap
    // would surface to a CJS require as `{ default: fn }` — and the
    // downstream callsite `_objectWithoutPropertiesLoose2(...)` calls
    // the namespace as a function and crashes with
    // `_objectWithoutPropertiesLoose2 is not a function` at runtime.
    //
    // This is the same logic Node uses: `require()` triggers the
    // `require` condition, `import` triggers `import`. esbuild's own
    // resolver does this when it owns resolution; we own it via the
    // VFS plugin, so we must pass conditions through ourselves.
    //
    // Affects every CJS-shipping npm package that depends on
    // `@babel/runtime/helpers/*` (thousands — anything compiled with
    // @babel/preset-env's `transform-runtime`). Verified to fix:
    //   - react-textarea-autosize → Markflow's /write route
    //   - @emotion/* CJS bundles
    //   - downstream of `babel-plugin-transform-runtime`
    const ESM_CONDITIONS = ['import', 'module', 'browser', 'default'];
    const CJS_CONDITIONS = ['require', 'node', 'browser', 'default'];
    // Bare specifier → entry path resolution. Mirrors EsbuildService's
    // makeVfsPlugin.resolveBarePkg but reads from fileMap.
    const resolveBarePkg = (specifier, fromDir, conditions) => {
        let pkgName, subpath;
        if (specifier.startsWith('@')) {
            const parts = specifier.split('/');
            pkgName = parts.slice(0, 2).join('/');
            subpath = parts.slice(2).join('/');
        }
        else {
            const parts = specifier.split('/');
            pkgName = parts[0];
            subpath = parts.slice(1).join('/');
        }
        let dir = stripLeadingSlash(fromDir);
        const visited = new Set();
        while (dir && !visited.has(dir)) {
            visited.add(dir);
            const nm = '/' + dir + '/node_modules/' + pkgName;
            if (dirExists(nm)) {
                const pkgJsonPath = nm + '/package.json';
                if (fileExists(pkgJsonPath)) {
                    try {
                        const pkgJsonText = new TextDecoder().decode(fileMap.get(pkgJsonPath));
                        const pkgJson = JSON.parse(pkgJsonText);
                        const subKey = subpath ? './' + subpath : '.';
                        // @ts-ignore — `resolvePackageEntry` is provided by the
                        // pre-bundle preamble at facet-load time; no static import.
                        const entry = resolvePackageEntry(pkgJson, subKey, conditions);
                        if (entry) {
                            const r = tryResolve(nm + '/' + entry.replace(/^\.\//, ''));
                            if (r)
                                return r;
                        }
                    }
                    catch { /* fall through */ }
                }
                if (subpath) {
                    const r = tryResolve(nm + '/' + subpath);
                    if (r)
                        return r;
                }
                const r2 = tryResolve(nm + '/index');
                if (r2)
                    return r2;
            }
            const lastSlash = dir.lastIndexOf('/');
            if (lastSlash <= 0)
                break;
            dir = dir.substring(0, lastSlash);
        }
        return null;
    };
    const externalSet = new Set();
    const externalPrefixes = [];
    for (const pat of spec.externals) {
        if (pat.endsWith('/*'))
            externalPrefixes.push(pat.slice(0, -1));
        else
            externalSet.add(pat);
    }
    const isExternal = (s) => {
        if (externalSet.has(s))
            return true;
        for (const pre of externalPrefixes)
            if (s.startsWith(pre))
                return true;
        return false;
    };
    const inferLoader = (path) => {
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
    };
    const plugin = {
        name: 'nimbus-pre-bundle-slice',
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                // Subpath imports (#X) — resolve against the importing module's
                // owning package.json `imports` field (Node spec). Done BEFORE
                // the bare/external/absolute branches so a #X never falls
                // through to `external` (which would leak it to the browser
                // and crash the preview with "Failed to resolve module
                // specifier #X").
                if (args.path.startsWith('#') && args.resolveDir) {
                    const r = resolvePackageImport(args.path, args.resolveDir);
                    if (r)
                        return { path: r, namespace: 'nimbus-slice' };
                    // Fall through to `external` only as a last resort. We log a
                    // warning so the supervisor can surface "looks like #X is
                    // unresolved" rather than the user seeing an opaque crash.
                    warnings.push(`unresolved subpath import "${args.path}" from ${args.importer || '?'} ` +
                        `(no owning package.json#imports entry); marked external`);
                    return { external: true };
                }
                // Bare external — leave for the browser to resolve.
                if (!args.path.startsWith('/') && !args.path.startsWith('.') && !args.path.startsWith('#')) {
                    if (isExternal(args.path))
                        return { external: true };
                }
                if (args.path.startsWith('/')) {
                    const r = tryResolve(args.path);
                    if (r)
                        return { path: r, namespace: 'nimbus-slice' };
                }
                if (args.path.startsWith('.') && args.resolveDir) {
                    const r = tryResolve(args.resolveDir + '/' + args.path);
                    if (r)
                        return { path: r, namespace: 'nimbus-slice' };
                }
                if (!args.path.startsWith('/') && !args.path.startsWith('.') && !args.path.startsWith('#')) {
                    const fromDir = args.resolveDir || '/home/user';
                    // Per Node spec: `require()` selects 'require' condition,
                    // `import` selects 'import'. esbuild surfaces this via
                    // args.kind. See ESM_CONDITIONS / CJS_CONDITIONS comments
                    // above for the bug class this fixes.
                    const conditions = args.kind === 'require-call' || args.kind === 'require-resolve'
                        ? CJS_CONDITIONS
                        : ESM_CONDITIONS;
                    const r = resolveBarePkg(args.path, fromDir, conditions);
                    if (r)
                        return { path: r, namespace: 'nimbus-slice' };
                    // Mark unresolved as external — same fail-soft behaviour as
                    // EsbuildService.makeVfsPlugin, with a warning so the slice
                    // walker can be tightened.
                    warnings.push(`unresolved bare import "${args.path}" from ${args.importer || '?'} → marked external`);
                    return { external: true };
                }
                return { external: true };
            });
            build.onLoad({ filter: /.*/, namespace: 'nimbus-slice' }, (args) => {
                const bytes = fileMap.get(norm(args.path));
                if (!bytes) {
                    return { errors: [{ text: 'pre-bundle slice miss: ' + args.path }] };
                }
                const loader = inferLoader(args.path);
                const lastSlash = args.path.lastIndexOf('/');
                const resolveDir = lastSlash > 0 ? args.path.substring(0, lastSlash) : '/';
                if (loader === 'binary') {
                    return { contents: bytes, loader, resolveDir };
                }
                const text = new TextDecoder().decode(bytes);
                return { contents: text, loader, resolveDir };
            });
        },
    };
    // 4. Run esbuild.
    try {
        // NOTE: do NOT pass `external: spec.externals` here at the top level.
        // esbuild's top-level external matches by file PATH too — when bundling
        // a subpath like 'react/jsx-runtime', the resolved entry path
        // /home/user/app/node_modules/react/jsx-runtime.js matches the 'react'
        // external and esbuild errors with
        //   "The entry point '...' cannot be marked as external"
        //
        // Externals are enforced by the VFS plugin's onResolve callback above
        // (line ~524), which only matches BARE specifiers — never the entry
        // path. This means jsx-runtime CAN externalize 'react' without
        // tripping the entry check, AND react-dom/client CAN externalize
        // 'react' / 'react/jsx-runtime' the same way.
        const result = await esb.build({
            entryPoints: [spec.entryPath.startsWith('/') ? spec.entryPath : '/' + spec.entryPath],
            bundle: true,
            format: 'esm',
            target: 'esnext',
            platform: 'browser',
            write: false,
            conditions: ['import', 'module', 'browser', 'default'],
            mainFields: ['module', 'browser', 'main'],
            define: spec.define && Object.keys(spec.define).length > 0 ? spec.define : undefined,
            plugins: [plugin],
        });
        const out = result.outputFiles?.[0];
        if (!out) {
            return {
                specifier: spec.specifier,
                ok: false,
                esmCode: '',
                errorText: 'no output produced',
                elapsed: Date.now() - t0,
                warnings,
            };
        }
        return {
            specifier: spec.specifier,
            ok: true,
            esmCode: out.text,
            elapsed: Date.now() - t0,
            warnings,
        };
    }
    catch (e) {
        const msg = e?.errors?.[0]?.text || e?.message || String(e);
        return {
            specifier: spec.specifier,
            ok: false,
            esmCode: '',
            errorText: msg,
            elapsed: Date.now() - t0,
            warnings,
        };
    }
};
// Re-export so the supervisor can stamp results without re-importing.
export { BUNDLER_VERSION };
