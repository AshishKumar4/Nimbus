/**
 * require-resolver.ts — Server-side dependency graph resolver for Nimbus.
 *
 * Runs on the supervisor (which has synchronous VFS access) to trace
 * all require() calls and build a complete file bundle reachable from
 * the entry point. The output is consumed by worker `facets/manager.ts`
 * to ship the reachable set into
 * the dynamic-worker module (rather than every file in node_modules
 * up to the legacy cap).
 *
 * Algorithm:
 *   1. Parse `require('xxx')` / `require("xxx")` / ``require(`xxx`)``
 *      and `require.resolve('xxx')` calls from entry code via regex.
 *   2. Resolve each with require-resolution.ts, over the SHARED `resolvePackageEntry` helper from
 *      src/_shared/exports-resolver.ts — same impl that node-shims
 *      and npm-resolver use, so prefetch and runtime always agree on
 *      which file `require('xyz')` means (W2.6a D6: no dual impls).
 *   3. Read the resolved file, recursively parse ITS requires.
 *   4. Return Record<string, string> of path → content.
 *
 * Static analysis still misses dynamic requires like `require(variable)`;
 * The module-map construction in worker facets/manager.ts also admits learned
 * reads without limiting the statically-proven require closure.
 *
 * History: this file was ARC-A-P1 quarantined after W2 because the
 * legacy `buildVfsBundle` walked every file in node_modules. W2.6a
 * de-quarantines it as the primary content-bundle source.
 */
import { METADATA_CANDIDATE_WORK, resolveRequireEx, strip, } from './require-resolution.js';
import { FACET_PROVIDED_PACKAGES, VFS_BUNDLE_MAX_BYTES } from '../constants.js';
import { isNativeBinPath } from './os-contracts.js';
import { stripCommentsForImports } from './comment-strip.js';
import { createEsmResolver } from '../_shared/esm-resolver.js';
import { forEachNode, parseJavaScriptProgram } from './javascript-ast.js';
// The CommonJS resolver this walk stages from (require-resolution.ts).
export { requireFsOverBridge } from './require-resolution.js';
// Match literal-string require/require.resolve with single, double, or
// template-literal-no-interp specifier. The plain-string variant is by
// far the dominant npm pattern; the others catch a long tail of
// well-known cases (esbuild plugins, vite internals).
const REQUIRE_RE = /(?:require(?:\.resolve)?\s*\(\s*)(['"`])([^'"`]+?)\1\s*\)/g;
// Static-string dynamic import: `import('literal')`. CLI entrypoints often
// defer their real implementation through one (e.g. create-astro's
// create-astro.mjs does `import('./dist/index.js').then(({main}) => main())`).
// Without following it, the target file's content is excluded from the
// bounded snapshot, so the runtime dynamic import resolves the path but
// can't read it — the scaffolder exits silently. Only literal specifiers
// are followed; computed `import(expr)` remains out of scope. An entry
// script the shell already transformed has them as the process's loader
// calls (dynamic-import-rewrite.ts), `__nimbusDynamicImport("<parent>", "x")`.
const DYNIMPORT_RE = /(?:\bimport\s*\(|\b__nimbusDynamicImport\(\s*"[^"]*"\s*,)\s*(['"`])([^'"`]+?)\1\s*\)/g;
// Immediately-invoked `createRequire(<expr>)('literal')`. pi-coding-agent's
// bin (dist/bundle/cli.js) is exactly:
//   import { createRequire, enableCompileCache } from "node:module";
//   enableCompileCache();
//   createRequire(import.meta.url)("./cli-runtime.js");
// None of REQUIRE_RE / IMPORT_RE / DYNIMPORT_RE match that call, so the
// walker staged nothing beyond cli.js and the whole graph loaded lazily at
// runtime, failing at the first `exports`-map subpath it met
// (`@earendil-works/chord/context`) because chord's manifest was never
// staged. `createRequire(import.meta.url)` resolves relative to the
// current file, which is what `fromDir` already is. Deliberately narrow:
// the argument may not contain `)` and only the immediately-invoked form is
// matched; a bound `const require = createRequire(...)` is left alone
// because its later `require('x')` calls already match REQUIRE_RE.
const CREATE_REQUIRE_CALL_RE = /\bcreateRequire\s*\([^)]*\)\s*\(\s*(['"`])([^'"`]+?)\1\s*\)/g;
// X.5-C Fix #1: match ESM `import` and `export … from` statements.
//
// Why a second regex (not a unified one): REQUIRE_RE matches require(…)
// CALL EXPRESSIONS — those can appear anywhere (inside function bodies,
// conditionals, etc.). ESM import/export are STATEMENTS — they can only
// appear at the top of a line (modulo whitespace). Anchoring at start-of-
// line `(^|\n)\s*` avoids matching the substring `import` inside string
// literals or identifiers like `obj.import`. Same anchor strategy that
// `looksLikeEsm` in worker facets/manager.ts uses (precedent set by W3.5 Fix B).
//
// Forms covered by IMPORT_RE:
//   import 'x';                          ← side-effect (no `from`)
//   import x from 'x';                   ← default
//   import * as x from 'x';              ← namespace
//   import {a, b as c} from 'x';         ← named
//   import x, {a} from 'x';              ← mixed default+named
//   export {a, b} from 'x';              ← re-export named
//   export * from 'x';                   ← re-export wildcard
//   export * as ns from 'x';             ← re-export wildcard with alias
//   export {default as x} from 'x';      ← named-as-default re-export
//
// NOT covered (deliberate):
//   import('x') / import.meta.<x>       ← dynamic — needs full parsing;
//                                          out of scope for prefetch.
//   `import type {…} from 'x'` (TypeScript) ← matched, but the resolver
//                                          returns null on .d.ts-only
//                                          specifiers and the walk no-ops.
//
// The middle group `[\w*${},\s{}]*` covers the practical identifier /
// destructuring shapes; alternation `(?:…)?` allows the `from` segment
// to be omitted (side-effect imports). String literal at the end is a
// single- or double-quoted spec.
//
// X.5-Z5 §3 (extended): leading anchor relaxed from (^|\n) to (^|[\n;}])
// AND the body widened to optionally allow no-whitespace `import{` /
// `export{` shapes. Same dual-relaxation as worker facets/manager.ts
// looksLikeEsm — minified ESM bundles (notably @tailwindcss/vite/dist/
// index.mjs) put the first `;import{...}from"..."` after a `;` on the
// same line, which the original anchor missed → prefetch walker silently
//
// Edge: a literal `\nimport x from 'y'` inside a multi-line string would
// false-positive. The walker no-ops on missed resolutions, so it's a
// minor wasted-work cost, not a correctness issue.
const IMPORT_RE = /(?:^|[\n;}])\s*(?:import|export)(?:[\s{][\w*${}\s,]*?\s*from)?\s*(['"])([^'"]+)\1/g;
// Only the speculative ESM resolution boundary catches traversal failures.
// Keep scheduling errors distinct there, then return the original cause.
class WalkControlFailure extends Error {
}
/** Error form of `ClosureBoundExceeded` for callers that cannot return it. */
export class ClosureBoundExceededError extends Error {
    outcome;
    constructor(outcome) {
        super(`require closure for ${outcome.entry} exceeds the ${outcome.bound}-byte ` +
            `snapshot bound (${outcome.bytesSeen} bytes staged, stopped at ${outcome.lastPath})`);
        this.outcome = outcome;
        this.name = 'ClosureBoundExceededError';
    }
}
export async function prefetchForRequire(vfs, entryCode, cwd, entryFile, maxBundleBytes = VFS_BUNDLE_MAX_BYTES, progress, policy, requiredRoots) {
    const report = progress;
    if (report)
        progress = async (work) => {
            try {
                await report(work);
            }
            catch (cause) {
                throw new WalkControlFailure('Dependency walk interrupted', { cause });
            }
        };
    const bundle = {};
    const speculative = new Set();
    const visited = new Set();
    let bytesSeen = 0;
    let closureExceeded = null;
    let declined = null;
    let additionalBytes = 0;
    let additionalFiles = 0;
    const encoder = new TextEncoder();
    function fits(path, bytes) {
        if (!policy || policy.held[path] !== undefined)
            return true;
        if (additionalFiles >= policy.maxAdditionalFiles)
            declined = { kind: 'dependency-closure-declined', path, reason: 'files' };
        else if (additionalBytes + bytes > policy.maxAdditionalBytes)
            declined = { kind: 'dependency-closure-declined', path, reason: 'bytes' };
        return declined === null;
    }
    // Metadata spends the same delta allowance as source.
    async function stageCell(path, kind = 'module') {
        if (declined || closureExceeded)
            return null;
        if (bundle[path] !== undefined)
            return bundle[path];
        if (progress)
            await progress(METADATA_CANDIDATE_WORK + path.length);
        const held = policy?.held[path];
        const authorize = vfs.assertReadable;
        const reuseHeld = typeof held === 'string' && authorize !== undefined;
        if (reuseHeld) {
            try {
                await authorize.call(vfs, path);
            }
            catch {
                declined = { kind: 'dependency-closure-declined', path, reason: 'unreadable' };
                return null;
            }
        }
        let size = 0;
        if (!reuseHeld && (policy || kind === 'module')) {
            try {
                size = (await vfs.stat(path))?.size ?? 0;
            }
            catch { /* the read decides */ }
            if (!fits(path, size))
                return null;
            if (!policy && kind === 'module' && bytesSeen + size > maxBundleBytes) {
                if (!lazy)
                    closureExceeded = { kind: 'closure-exceeds-bound', entry: entryFile ?? 'entry code', bytesSeen, bound: maxBundleBytes, lastPath: path };
                return null;
            }
        }
        let content;
        try {
            content = reuseHeld ? held : await vfs.readFileString(path);
        }
        catch {
            if (policy)
                declined = { kind: 'dependency-closure-declined', path, reason: 'unreadable' };
            return null;
        }
        if (held !== undefined && content !== held) {
            declined = { kind: 'dependency-closure-declined', path, reason: 'unreadable' };
            return null;
        }
        if (policy && held === undefined) {
            const actual = encoder.encode(content).byteLength;
            if (!fits(path, actual))
                return null;
            additionalBytes += actual;
            additionalFiles++;
        }
        if (!policy && kind === 'module')
            bytesSeen += size;
        bundle[path] = content;
        if (lazy && kind === 'module')
            speculative.add(path);
        if (progress)
            await progress(content.length);
        return content;
    }
    // Followed after the static closure so a lazy subtree never spends its
    // bound: fewest alternatives first, then in discovery order.
    // A module that defers one import (vitefu's CommonJS proxy, `import('./index.js')`
    // inside each async function) loads it whenever that code runs; a module
    // that defers hundreds (Shiki's grammar table, one `import()` per language)
    // loads the few its input names. Walking a table first spent the bound on
    // grammars the program never loads, and cut the deferral it does.
    const deferredDynamic = new Map();
    function defer({ specifier, fromDir, alternatives }) {
        let queue = deferredDynamic.get(alternatives);
        if (queue === undefined)
            deferredDynamic.set(alternatives, queue = []);
        queue.push({ specifier, fromDir });
    }
    function nextDeferred() {
        let fewest = Infinity;
        for (const [alternatives, queue] of deferredDynamic)
            if (queue.length > 0 && alternatives < fewest)
                fewest = alternatives;
        if (fewest === Infinity)
            return undefined;
        return { ...deferredDynamic.get(fewest).shift(), alternatives: fewest };
    }
    // A package the code locates by its manifest (`require.resolve('vite/package.json')`)
    // is one it uses from where it is installed: vinext reads that manifest's
    // `bin` and imports Vite's CLI from the path it names. Those bins are a
    // guess at what the code does with the package, so they wait behind every
    // deferral the code names itself.
    function deferBins(manifestPath) {
        let manifest;
        try {
            manifest = JSON.parse(String(bundle[manifestPath]));
        }
        catch {
            return;
        }
        const bin = manifest !== null && typeof manifest === 'object' && 'bin' in manifest ? manifest.bin : undefined;
        const targets = typeof bin === 'string' ? [bin] : bin !== null && typeof bin === 'object' ? Object.values(bin) : [];
        const fromDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
        for (const target of targets) {
            // npm links no bin outside its package.
            if (typeof target !== 'string' || target.split('/').includes('..'))
                continue;
            defer({ specifier: './' + target.replace(/^\.\//, ''), fromDir, alternatives: LOCATED_PACKAGE_BINS });
        }
    }
    // A tool loads what its config names as the config's own require would
    // resolve it (postcss-load-config: createRequire(config).resolve(name)),
    // so each is resolved that way and deferred by its path.
    async function deferConfigNames(configPath) {
        const fromDir = configPath.slice(0, configPath.lastIndexOf('/'));
        const names = configPackageNames(bundle[configPath]).filter((name) => !isFacetProvided(name));
        const resolved = [];
        for (const name of names) {
            const r = await resolveRequireEx(vfs, name, fromDir, undefined, progress);
            if (r)
                resolved.push(r.resolved);
        }
        for (const target of resolved)
            defer({ specifier: '/' + target, fromDir, alternatives: resolved.length });
    }
    let lazy = false;
    // `entry`: the entry file itself, whose own `import()` is a deferral of its
    // main module, not an optional feature, and is followed as required.
    async function addFile(vfsPath, entry = false) {
        if (closureExceeded || declined || visited.has(vfsPath))
            return;
        visited.add(vfsPath);
        // A native binary is answered by the ABI policy, never loaded from the map.
        if (isNativeBinPath(vfsPath))
            return;
        // Stat before read: a required file is not optional, so if its size
        // would carry the bundle past the bound the closure cannot launch —
        // stop here rather than buy the read that resets the isolate. A stat
        // failure means the size is unknown; the read attempt decides, as it
        // did before this gate existed.
        const content = await stageCell(vfsPath);
        if (content === null)
            return;
        // Also add the package.json for the enclosing node_modules package
        // so the runtime resolver can read the same exports/main field we
        // walked here.
        if (vfsPath.includes('node_modules/')) {
            const parts = vfsPath.split('/');
            const nmIdx = parts.lastIndexOf('node_modules');
            if (nmIdx >= 0) {
                const pkgEnd = parts[nmIdx + 1]?.startsWith('@') ? nmIdx + 3 : nmIdx + 2;
                const pkgJsonPath = parts.slice(0, pkgEnd).join('/') + '/package.json';
                if (progress)
                    await progress(METADATA_CANDIDATE_WORK + pkgJsonPath.length);
                if (!visited.has(pkgJsonPath) && (await vfs.exists(pkgJsonPath))) {
                    visited.add(pkgJsonPath);
                    await stageCell(pkgJsonPath, 'metadata');
                }
            }
        }
        // Bug class C (audit 2026-05-11): ship every ancestor package.json
        // up to a node_modules boundary so the runtime __resolveFile pkg.main
        // branch can read them. For a path like mod/lib/api.js (resolved
        // via mod/package.json#main='lib/api.js'), the runtime resolver
        // needs mod/package.json in the bundle even though api.js lives
        // one level deeper. Walking up covers nested-main cases.
        //
        // Bound: stops at node_modules boundary (existing block above
        // handles that case) or when we run out of parent dirs. Each step
        // costs one vfs.exists() — typical project depth is 3-5 dirs.
        if (!vfsPath.includes('node_modules/')) {
            let dir = vfsPath;
            while (true) {
                const sl = dir.lastIndexOf('/');
                if (sl <= 0)
                    break;
                dir = dir.substring(0, sl);
                const dirPkgJson = dir + '/package.json';
                if (visited.has(dirPkgJson))
                    break; // already shipped, stop walking
                if (progress)
                    await progress(METADATA_CANDIDATE_WORK + dirPkgJson.length);
                if ((await vfs.exists(dirPkgJson)) && !(await vfs.isDirectory(dirPkgJson))) {
                    visited.add(dirPkgJson);
                    await stageCell(dirPkgJson, 'metadata');
                }
            }
        }
        // Recursively resolve require() calls in this file. Bin scripts and
        // shims are commonly extensionless (e.g. node_modules/<pkg>/bin/<cli>
        // with a `#!/usr/bin/env node` shebang), so an extension allowlist
        // would drop their require chain. Treat .json as data (no requires);
        // walk everything else as CJS/ESM.
        if (!vfsPath.endsWith('.json')) {
            const fromDir = vfsPath.includes('/') ? vfsPath.substring(0, vfsPath.lastIndexOf('/')) : '.';
            (await parseAndResolve(content, fromDir, entry));
        }
    }
    async function parseAndResolve(code, fromDir, entry = false) {
        if (declined || closureExceeded)
            return;
        if (progress)
            await progress(code.length);
        // esbuild-ast-rewrite (P3 decision: Option D): strip `//` and
        // `/* */` comments before running IMPORT_RE / REQUIRE_RE so the
        // regexes don't break on embedded comments. Real-world bite:
        // chalk's `import { // eslint-disable-line\n a, b\n} from
        // './utilities.js';` (lines 3-6 of chalk@5.x source/index.js)
        // and its multi-line `export { ... // TODO ... } from
        // './vendor/ansi-styles/index.js';` (lines 196-209) both fail
        // IMPORT_RE's lazy character class because comment characters
        // are not in `[\w*${}\s,]*?`. Stripping comments to whitespace
        // (newline-preserved) makes the rest of the regex match
        // correctly.
        //
        // Why Option D (regex + comment-strip) over Option A (full
        // structured AST extraction via esbuild metafile):
        //   - Empirical 100-file session bootstrap with AST: ~553 ms
        //     esbuild-ast-rewrite/measure-result.txt). Over the 500 ms
        //     decision gate, and that's local Node — workerd-wasm cost
        //     is 2-3× higher.
        //   - Regex (this preprocessor) per file: ~0.1 ms
        //   - Correctness gap closed: chalk's bug case now matches both
        //     specifiers AST found but regex missed.
        // See `comment-strip.ts` header + the wave's verdict.md.
        const stripped = stripCommentsForImports(code);
        // Recursive and concurrently suspended walks each own their cursor.
        // Mutating a shared RegExp.lastIndex repeats or skips a parent's imports.
        for (const match of stripped.matchAll(REQUIRE_RE)) {
            const specifier = match[2];
            if (isFacetProvided(specifier))
                continue;
            if (closureExceeded || declined)
                break;
            const r = await resolveStaticDependency(specifier, fromDir);
            if (r)
                (await addFile(r.resolved));
            if (r && !policy && namesManifest(specifier))
                deferBins(r.resolved);
        }
        // Immediately-invoked `createRequire(import.meta.url)('./x')` is a
        // require of './x' from this file's directory (pi-coding-agent's bin).
        for (const match of stripped.matchAll(CREATE_REQUIRE_CALL_RE)) {
            const specifier = match[2];
            if (isFacetProvided(specifier))
                continue;
            if (closureExceeded || declined)
                break;
            const r = await resolveStaticDependency(specifier, fromDir);
            if (r)
                (await addFile(r.resolved));
        }
        // X.5-C Fix #1: also follow ESM `import`/`export … from` statements.
        // Without this, packages whose `module` entry is ESM (react-remove-
        // scroll, pathe, ESM nuxt deps, etc.) have their entry file in the
        // bundle but none of the relative `import './x'` siblings — at
        // runtime W3.5 Fix B's CJS rewrite calls require('./x') which then
        // fails because `x` was never added.
        for (const match of stripped.matchAll(IMPORT_RE)) {
            const specifier = match[2];
            if (isFacetProvided(specifier))
                continue;
            if (closureExceeded || declined)
                break;
            const r = await resolveStaticDependency(specifier, fromDir);
            if (r)
                (await addFile(r.resolved));
        }
        // Entry deferrals are required; the rest wait for phase 2 (PrefetchResult.speculative).
        const deferrals = new Set();
        for (const match of stripped.matchAll(DYNIMPORT_RE)) {
            if (declined)
                break;
            const specifier = match[2];
            if (isFacetProvided(specifier))
                continue;
            // A dependency closure is never an entry: its deferrals are reported, not walked.
            if (!entry) {
                deferrals.add(specifier);
                continue;
            }
            const resolved = (await resolveDynamicImport(specifier, fromDir));
            if (closureExceeded)
                break;
            if (resolved)
                (await addFile(resolved));
        }
        for (const specifier of deferrals)
            defer({ specifier, fromDir, alternatives: deferrals.size });
    }
    // A dynamic `import()` loads what Node's ESM resolver names (the process's
    // loader resolves it the same way, core/_shared/esm-resolver.ts): the
    // "import" conditions, no extension probing. The package.json files it
    // reads are staged too, since the loader reads the same ones.
    const esm = walkEsmResolver(vfs, progress, async (path) => await addPkgJson(strip(path)));
    async function resolveStaticDependency(specifier, fromDir) {
        // Vite's generated config names dependencies by absolute file URL.
        if (specifier.startsWith('file:')) {
            const resolved = await resolveDynamicImport(specifier, fromDir);
            return resolved === null ? null : { resolved };
        }
        return resolveRequireEx(vfs, specifier, fromDir, addPkgJson, progress);
    }
    /** The file a dynamic import from `fromDir` loads, or null (a builtin, a data: URL, or an error the loader reports). */
    async function resolveDynamicImport(specifier, fromDir) {
        return await resolveImportWith(esm, specifier, fromDir);
    }
    /**
     * Sink for intermediate package.json files consulted during
     * LOAD_AS_DIRECTORY resolution (see PkgJsonSink). Adds the content
     * verbatim — package.json carries no requires, so no recursion and no
     * enclosing-package piggyback is needed.
     */
    async function addPkgJson(pkgJsonPath) {
        const k = strip(pkgJsonPath);
        const content = await stageCell(k, 'metadata');
        visited.add(k);
        return content;
    }
    // Start from entry code.
    //
    // Primitive #1 (runtime primitive support): the relative-require
    // resolution base is the ENTRY FILE's directory when the caller
    // supplied one (bin shims under node_modules/.bin/, npx-launched
    // scripts, etc.), NOT cwd. Pre-fix, `require('../lib/tsc.js')` from
    // `node_modules/typescript/bin/tsc` resolved against the user's
    // cwd, finding `<cwd>/../lib/tsc.js` which doesn't exist.
    //
    // Falling back to cwd preserves the legacy behaviour for naked
    // entryCode (no file context) — covers the `node -e '<code>'`
    // path where opts.filename is '<eval>'.
    async function walk() {
        const cwdStripped = strip(cwd);
        let entryFromDir = cwdStripped;
        if (entryFile) {
            const stripped = strip(entryFile);
            const slash = stripped.lastIndexOf('/');
            if (slash > 0)
                entryFromDir = stripped.substring(0, slash);
        }
        await parseAndResolve(entryCode, entryFromDir, policy === undefined);
        // If there's an entry file, add it (and recurse).
        if (entryFile)
            await addFile(strip(entryFile), policy === undefined);
        const entryPaths = requiredRoots ? new Set(Object.keys(bundle)) : undefined;
        // Modules a previous launch actually tried to execute are required roots,
        // not speculative dynamic-import subtrees. Walk their static imports in
        // this same visited set and byte budget before any optional enrichment.
        for (const root of requiredRoots ?? []) {
            const path = strip(root.path);
            if (root.text === undefined)
                await addFile(path);
            else
                await parseAndResolve(root.text, path.slice(0, path.lastIndexOf('/')));
            if (closureExceeded || declined)
                break;
            if (root.config && typeof bundle[path] === 'string')
                await deferConfigNames(path);
        }
        // Also add cwd package.json if it exists (for npm scripts, main field etc).
        const cwdPkg = cwdStripped + '/package.json';
        if (progress)
            await progress(METADATA_CANDIDATE_WORK + cwdPkg.length);
        if ((await vfs.exists(cwdPkg)) && !visited.has(cwdPkg)) {
            await addPkgJson(cwdPkg);
        }
        if (declined)
            return declined;
        if (closureExceeded)
            return closureExceeded;
        if (policy) {
            const deferred = [];
            for (let next = nextDeferred(); next !== undefined; next = nextDeferred())
                deferred.push(next);
            return { bundle, speculative, entryPaths, deferred };
        }
        // Phase 2: dynamic-import subtrees, fewest alternatives first; the queue grows as they are walked.
        lazy = true;
        for (let next = nextDeferred(); next !== undefined && bytesSeen < maxBundleBytes; next = nextDeferred()) {
            const { specifier, fromDir } = next;
            const resolved = await resolveDynamicImport(specifier, fromDir);
            if (resolved)
                await addFile(resolved);
        }
        return { bundle, speculative, entryPaths };
    }
    try {
        return await walk();
    }
    catch (error) {
        if (error instanceof WalkControlFailure)
            throw error.cause;
        throw error;
    }
}
const BUILTINS = new Set([
    'fs', 'path', 'os', 'events', 'stream', 'buffer', 'util', 'url', 'crypto',
    'assert', 'querystring', 'string_decoder', 'child_process', 'process',
    'console', 'http', 'https', 'http2', 'net', 'dns', 'tls', 'tty',
    'module', 'timers', 'zlib', 'readline', 'perf_hooks', 'worker_threads',
    'vm', 'v8', 'inspector', 'cluster', 'domain', 'punycode', 'wasi',
    'trace_events', 'dgram', 'sqlite', 'repl',
]);
/**
 * Specifiers the walker must not follow: the facet resolves them from its own
 * `builtins` table, never from the bundle. That is node core plus the npm
 * packages the facet provides itself — walking those would spend the bundle's
 * file and byte budget shipping sources that `require()` can never reach.
 */
function isFacetProvided(id) {
    if (id.startsWith('node:'))
        return true;
    return BUILTINS.has(id) || FACET_PROVIDED_PACKAGES.includes(id);
}
/**
 * Node's ESM resolver over the walk's filesystem (the process's loader
 * resolves the same way, core/_shared/esm-resolver.ts): the "import"
 * conditions, no extension probing. The walk sees paths as the module map
 * holds them; `readText` answers the package.json files it reads.
 */
function walkEsmResolver(vfs, progress, readText) {
    return createEsmResolver({
        async kind(path) {
            const key = strip(path);
            if (progress)
                await progress(METADATA_CANDIDATE_WORK + key.length);
            if (!(await vfs.exists(key)))
                return null;
            return (await vfs.isDirectory(key)) ? 'directory' : 'file';
        },
        realpath: (path) => path,
        readText,
        isBuiltin: (specifier) => isFacetProvided(specifier),
        cjsResolve: () => null,
    });
}
async function resolveImportWith(esm, specifier, fromDir) {
    const parentUrl = 'file:///' + (fromDir ? fromDir + '/' : '') + '[import]';
    try {
        const resolution = await esm.resolve(specifier, parentUrl);
        return resolution.path === undefined ? null : strip(resolution.path);
    }
    catch (error) {
        if (error instanceof WalkControlFailure)
            throw error;
        return null;
    }
}
/**
 * The file a deferral a dependency closure reported (PrefetchResult.deferred)
 * loads, or null; resolved as the walk resolves its own, staging nothing:
 * the closure that admits the file stages the package.json files it needs.
 */
export async function resolveDeferredImport(vfs, deferral, progress) {
    // A failed turn is the caller's failure, never an unresolved specifier.
    const paced = progress && (async (work) => {
        try {
            await progress(work);
        }
        catch (cause) {
            throw new WalkControlFailure('Dependency walk interrupted', { cause });
        }
    });
    const esm = walkEsmResolver(vfs, paced, async (path) => {
        try {
            return await vfs.readFileString(strip(path));
        }
        catch {
            return null;
        }
    });
    try {
        return await resolveImportWith(esm, deferral.specifier, deferral.fromDir);
    }
    catch (error) {
        if (error instanceof WalkControlFailure)
            throw error.cause;
        throw error;
    }
}
/** An npm package name: `name` or `@scope/name` (lowercase, URL-safe). */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/;
/**
 * The package names a config spells as a string or a property key
 * (`plugins: { tailwindcss: {} }`, `plugins: ['prettier-plugin-x']`), less
 * its import and export sources, which the walk follows already. A config
 * acorn cannot parse (TypeScript) names none.
 */
export function configPackageNames(source) {
    const program = parseJavaScriptProgram(source);
    if (program === null)
        return [];
    const sources = new Set();
    const names = new Set();
    forEachNode(program, (node) => {
        if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.source) {
            sources.add(node.source);
        }
        let text;
        if (node.type === 'Literal' && !sources.has(node))
            text = node.value;
        else if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier')
            text = node.key.name;
        if (typeof text === 'string' && PACKAGE_NAME.test(text))
            names.add(text);
    });
    return [...names];
}
/** Phase 2's last tier: the bins of a package the code located by its manifest. */
const LOCATED_PACKAGE_BINS = Number.MAX_SAFE_INTEGER;
/** `pkg/package.json` or `@scope/pkg/package.json`: an installed package's manifest, by name. */
function namesManifest(specifier) {
    const parts = specifier.split('/');
    return parts.length === (specifier.startsWith('@') ? 3 : 2) && parts[parts.length - 1] === 'package.json'
        && !parts[0].startsWith('.') && parts[0] !== '';
}
// Note: the shared resolver helpers are imported directly from
// src/_shared/exports-resolver.js by every caller (W2.6a D6 — single
// source of truth). No re-export needed here.
