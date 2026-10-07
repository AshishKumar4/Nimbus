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
import { METADATA_CANDIDATE_WORK, resolveRequireEx, } from './require-resolution.js';
import { FACET_PROVIDED_PACKAGES, VFS_BUNDLE_MAX_BYTES } from '../constants.js';
import { stripLeadingSlashes } from '../vfs/path.js';
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
export async function prefetchForRequire(vfs, entryCode, cwd, entryFile, maxBundleBytes = VFS_BUNDLE_MAX_BYTES, progress, policy, requiredRoots, conditions = []) {
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
    // The phase-2 unit staged whole or not at all (an optional learned root):
    // what it staged, and whether the bound cut its closure.
    let unit = null;
    /** The optional learned roots that landed, each with its closure (PrefetchResult.units). */
    const units = [];
    /**
     * A landed root's whole static closure among the optional cells: what it
     * staged, and what it reached that another root had staged before it (the
     * static edges say, a visited path's edges having been recorded when it
     * was walked), with the manifests its packages were resolved through. A
     * shared dependency is then in every group that needs it, and pruning one
     * group leaves it to the others. The required closure is not a member: it
     * is never pruned.
     */
    function unitClosure(root, staged) {
        const members = new Set(staged);
        const optional = (path) => speculative.has(path) && bundle[path] !== undefined;
        const queue = optional(root) ? [root] : [];
        if (queue.length > 0)
            members.add(root);
        while (queue.length > 0) {
            const at = queue.pop();
            for (const to of edges.get(at) ?? []) {
                if (members.has(to) || !optional(to))
                    continue;
                members.add(to);
                queue.push(to);
            }
        }
        for (const path of [...members]) {
            for (let dir = path.slice(0, path.lastIndexOf('/')); dir !== ''; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))) {
                const manifest = dir + '/package.json';
                if (optional(manifest))
                    members.add(manifest);
                if (PACKAGE_ROOT.test(dir) || !dir.includes('/'))
                    break;
            }
        }
        return [...members];
    }
    function fits(path, bytes) {
        if (!policy || policy.held[path] !== undefined)
            return true;
        if (additionalFiles >= policy.maxAdditionalFiles)
            declined = { kind: 'dependency-closure-declined', path, reason: 'files' };
        else if (additionalBytes + bytes > policy.maxAdditionalBytes)
            declined = { kind: 'dependency-closure-declined', path, reason: 'bytes' };
        return declined === null;
    }
    // Metadata spends the same delta allowance as source. In phase 2 (lazy),
    // metadata the required graph did not already read is as optional as the
    // module it resolves: bounded, and evictable.
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
        const counted = !policy && (kind === 'module' || lazy);
        if (!reuseHeld && (policy || counted)) {
            try {
                size = (await vfs.stat(path))?.size ?? 0;
            }
            catch { /* the read decides */ }
            if (!fits(path, size))
                return null;
            if (counted && bytesSeen + size > maxBundleBytes) {
                if (!lazy)
                    closureExceeded = { kind: 'closure-exceeds-bound', entry: entryFile ?? 'entry code', bytesSeen, bound: maxBundleBytes, lastPath: path };
                if (unit)
                    unit.cut = true;
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
        if (counted)
            bytesSeen += size;
        bundle[path] = content;
        if (lazy)
            speculative.add(path);
        if (unit)
            unit.staged.push([path, counted ? size : 0]);
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
    function defer({ specifier, fromDir, alternatives, path }) {
        let queue = deferredDynamic.get(alternatives);
        if (queue === undefined)
            deferredDynamic.set(alternatives, queue = []);
        queue.push({ specifier, fromDir, ...(path !== undefined ? { path } : {}) });
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
            // The package.json files this reads are staged: the process repeats it from them.
            const r = await resolveRequireEx(vfs, name, fromDir, addPkgJson, progress, conditions);
            if (r)
                resolved.push(r.resolved);
        }
        for (const target of resolved)
            defer({ specifier: target, fromDir, alternatives: resolved.length, path: target });
    }
    /** Tool configs found for the launch; phase 2 stages them first. */
    const configRoots = new Set();
    const optionalRoots = new Set();
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
                // A package.json the user may not look up is no package scope, as
                // Node's lookup reads it: a device mount shows nothing above the
                // directory its user consented to.
                const held = await (async () => vfs.exists(dirPkgJson))().catch((error) => {
                    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES')
                        return false;
                    throw error;
                });
                if (held && !(await vfs.isDirectory(dirPkgJson))) {
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
            (await parseAndResolve(content, fromDir, entry, vfsPath));
        }
    }
    const edges = new Map();
    function edge(from, to) {
        if (from === undefined || from === to)
            return;
        let children = edges.get(from);
        if (children === undefined)
            edges.set(from, children = []);
        if (!children.includes(to))
            children.push(to);
    }
    async function parseAndResolve(code, fromDir, entry = false, fromFile) {
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
        // Every static dependency is staged the same way: the CommonJS
        // resolution of its specifier, unless the facet provides it, until the
        // closure is full. What each grammar adds after is its own:
        //   - require()/require.resolve(): a manifest it names may carry bins.
        //   - Immediately-invoked `createRequire(import.meta.url)('./x')` is a
        //     require of './x' from this file's directory (pi-coding-agent's bin).
        //   - ESM `import`/`export … from` (X.5-C Fix #1): packages whose
        //     `module` entry is ESM (react-remove-scroll, pathe, ESM nuxt deps)
        //     need their relative siblings staged, since the process runs the
        //     module lowered to CommonJS and its require takes a package's
        //     "require" branch. A module runner that evaluates the same source
        //     itself (Vite's, under Astro) imports a package with import(), which
        //     takes the "import" branch: phase 2 resolves it (the same file as
        //     the require branch adds nothing), behind every deferral the code
        //     names, tables included (IMPORT_BRANCHES).
        const followUps = [
            [REQUIRE_RE, (specifier, staged) => { if (staged && !policy && namesManifest(specifier))
                    deferBins(staged.resolved); }],
            [CREATE_REQUIRE_CALL_RE, () => { }],
            // Resolved in phase 2, where what it reads is optional too.
            [IMPORT_RE, (specifier) => { if (!policy && !/^[./#]|^file:/.test(specifier))
                    defer({ specifier, fromDir, alternatives: IMPORT_BRANCHES }); }],
        ];
        // Recursive and concurrently suspended walks each own their cursor
        // (matchAll): mutating a shared RegExp.lastIndex repeats or skips a
        // parent's imports.
        for (const [grammar, followUp] of followUps) {
            for (const match of stripped.matchAll(grammar)) {
                const specifier = match[2];
                if (isFacetProvided(specifier))
                    continue;
                if (closureExceeded || declined)
                    break;
                const staged = await resolveStaticDependency(specifier, fromDir);
                if (staged) {
                    edge(fromFile, staged.resolved);
                    await addFile(staged.resolved);
                }
                followUp(specifier, staged);
            }
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
                await addFile(resolved);
        }
        for (const specifier of deferrals)
            defer({ specifier, fromDir, alternatives: deferrals.size });
    }
    // A dynamic `import()` loads what Node's ESM resolver names (the process's
    // loader resolves it the same way, core/_shared/esm-resolver.ts): the
    // "import" conditions, no extension probing. The package.json files it
    // reads are staged too, since the loader reads the same ones.
    const esm = walkEsmResolver(vfs, progress, async (path) => await addPkgJson(stripLeadingSlashes(path)), conditions);
    async function resolveStaticDependency(specifier, fromDir) {
        // Vite's generated config names dependencies by absolute file URL.
        if (specifier.startsWith('file:')) {
            const resolved = await resolveDynamicImport(specifier, fromDir);
            return resolved === null ? null : { resolved };
        }
        return resolveRequireEx(vfs, specifier, fromDir, addPkgJson, progress, conditions);
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
        const k = stripLeadingSlashes(pkgJsonPath);
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
        const cwdStripped = stripLeadingSlashes(cwd);
        let entryFromDir = cwdStripped;
        if (entryFile) {
            const stripped = stripLeadingSlashes(entryFile);
            const slash = stripped.lastIndexOf('/');
            if (slash > 0)
                entryFromDir = stripped.substring(0, slash);
        }
        await parseAndResolve(entryCode, entryFromDir, policy === undefined);
        // If there's an entry file, add it (and recurse).
        if (entryFile)
            await addFile(stripLeadingSlashes(entryFile), policy === undefined);
        const entryPaths = requiredRoots ? new Set(Object.keys(bundle)) : undefined;
        // Modules a previous launch actually tried to execute are required roots,
        // not speculative dynamic-import subtrees. Walk their static imports in
        // this same visited set and byte budget before any optional enrichment.
        // A tool config is not one (RequiredModuleRoot.config): phase 2's first.
        for (const root of requiredRoots ?? []) {
            if ('preload' in root) {
                if (isFacetProvided(root.specifier))
                    continue;
                const resolved = root.preload === 'require'
                    ? (await resolveStaticDependency(root.specifier, cwdStripped))?.resolved
                    : await resolveDynamicImport(root.specifier, cwdStripped);
                // Run before the entry, it is as much an entry: its own import()s are required too.
                // One that does not resolve fails in the process, as Node's does.
                if (resolved)
                    await addFile(resolved, policy === undefined);
                if (closureExceeded || declined)
                    break;
                continue;
            }
            const path = stripLeadingSlashes(root.path);
            if ((root.config || root.optional) && root.text === undefined) {
                if (root.config)
                    configRoots.add(path);
                if (root.optional)
                    optionalRoots.add(path);
                defer({ specifier: path, fromDir: path.slice(0, path.lastIndexOf('/')), alternatives: 0, path });
                continue;
            }
            // Its text is staged as runtime code (manager.ts _stagedRuntimeCode); only a required root walks it.
            if (root.optional)
                continue;
            if (root.text === undefined)
                await addFile(path);
            else
                await parseAndResolve(root.text, path.slice(0, path.lastIndexOf('/')));
            if (closureExceeded || declined)
                break;
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
            const resolved = next.path ?? await resolveDynamicImport(next.specifier, next.fromDir);
            if (!resolved)
                continue;
            // An optional learned root is staged whole or not at all: a module in
            // the map without what it imports fails where the module's late load
            // would have worked.
            // What it cut is taken back with its traversal: the paths it visited
            // and the deferrals it queued, so a root after it that shares a
            // dependency walks that dependency again rather than skipping it.
            unit = optionalRoots.has(resolved) ? { staged: [], cut: false } : null;
            const visitedBefore = visited.size;
            const queuedBefore = new Map([...deferredDynamic].map(([alternatives, queue]) => [alternatives, queue.length]));
            try {
                await addFile(resolved);
            }
            finally {
                if (unit?.cut) {
                    for (const [path, size] of unit.staged) {
                        delete bundle[path];
                        speculative.delete(path);
                        bytesSeen -= size;
                    }
                    let at = 0;
                    const walked = [];
                    for (const path of visited)
                        if (at++ >= visitedBefore)
                            walked.push(path);
                    for (const path of walked)
                        visited.delete(path);
                    for (const [alternatives, queue] of deferredDynamic)
                        queue.length = queuedBefore.get(alternatives) ?? 0;
                }
                else if (unit !== null) {
                    const members = unitClosure(resolved, unit.staged.map(([path]) => path));
                    if (members.length > 0)
                        units.push({ root: resolved, members });
                }
                unit = null;
            }
            if (configRoots.has(resolved) && typeof bundle[resolved] === 'string')
                await deferConfigNames(resolved);
        }
        return { bundle, speculative, entryPaths, edges, ...(units.length > 0 ? { units } : {}) };
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
function walkEsmResolver(vfs, progress, readText, conditions) {
    return createEsmResolver({
        async kind(path) {
            const key = stripLeadingSlashes(path);
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
    }, { conditions });
}
async function resolveImportWith(esm, specifier, fromDir) {
    const parentUrl = 'file:///' + (fromDir ? fromDir + '/' : '') + '[import]';
    try {
        const resolution = await esm.resolve(specifier, parentUrl);
        return resolution.path === undefined ? null : stripLeadingSlashes(resolution.path);
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
export async function resolveDeferredImport(vfs, deferral, progress, 
/** The program's own conditions, as its closure was walked under. */
conditions = []) {
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
            return await vfs.readFileString(stripLeadingSlashes(path));
        }
        catch {
            return null;
        }
    }, conditions);
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
/** A package's root directory under node_modules (`node_modules/name`, `node_modules/@scope/name`). */
const PACKAGE_ROOT = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/;
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
/**
 * Phase 2's tier for a package's "import" branch beside the "require" branch
 * the process loads: a module runner may import it, the code's own import()
 * calls certainly run. Ahead of a deferral table it shed 118 of Astro's Shiki
 * grammars (jsx.mjs and markdown.mjs among them), which a page's code block
 * loads with import().
 */
const IMPORT_BRANCHES = Number.MAX_SAFE_INTEGER - 1;
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
