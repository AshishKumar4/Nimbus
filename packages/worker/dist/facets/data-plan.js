/**
 * Which file contents a resident node process holds from its first
 * instruction, besides its module map.
 *
 * A synchronous read cannot wait for bytes, so whatever a process reads
 * synchronously has to be in its facet before it runs; the namespace (every
 * name and stat) is always there, content is not. This decides content by
 * rule, from the namespace and the module closure, without reading file
 * contents except a few package.json files:
 *
 *   package-json   every package.json (a one-shot, which plans no listing,
 *                  holds them from copies: manager.ts _installedManifests)
 *   project        the working tree, minus dependency, VCS and build-cache dirs
 *   convention     config and lockfile names in the working dir and above it
 *   package-data   non-code files under 256 KiB in every package the closure uses
 *   home           $HOME's dot entries (tool config, skills), minus caches
 *   typescript     when the closure has typescript: its lib .d.ts, @types/**,
 *                  and the declaration files of the packages @types depends on
 *   static         what the closure's own code names by a foldable path
 *                  (static-fs-refs.ts), resolved against the namespace:
 *                  under 256 KiB, or any size when the code reads it with
 *                  readFileSync (or a read-only openSync) by that path,
 *                  through any symlinks on it; and the file a specifier its
 *                  code resolves names, as its readers resolve it
 *   entries        the entry files the working dir's dependencies, and
 *                  their own dependencies, name (exports under every
 *                  condition, module, main, browser), under 256 KiB: a dev
 *                  server reads them synchronously to pre-bundle what the
 *                  app imports and what a framework includes for itself
 *                  (Vite's optimizer reads each with readFileSync), and the
 *                  process never loads them
 *   learned        paths earlier launches of the same package versions missed
 *
 * Code the closure loads is in the module map already; the store adopts a
 * file that is its own module, so it is readable as data too. A file whose
 * module is an emit and that the map does not carry (`codeOnly`: an ES module
 * staged only to run) is planned as any other file is.
 */
import { packageJsonText, parseResolvablePackageJson, resolvePackageEntry } from '@nimbus-sh/core/_shared/exports-resolver.js';
import { resolveFile } from '@nimbus-sh/core/runtime/require-resolution.js';
import { resolveDeferredImport } from '@nimbus-sh/core/runtime/require-resolver.js';
import { rootClampedSegments } from '@nimbus-sh/platform/lexical-path.js';
/** Package data this size or larger is a bundle or a binary, not configuration. */
export const PACKAGE_DATA_MAX_BYTES = 256 * 1024;
const CODE_FILE = /\.(?:c|m)?(?:j|t)sx?$|\.map$|\.d\.(?:c|m)?ts$|\.node$|\.wasm$/;
const DECLARATION_FILE = /\.d\.(?:c|m)?ts$/;
/** Directory names whose contents are dependencies, VCS state or regenerable caches. */
const PROJECT_EXCLUDED = new Set([
    'node_modules', '.git', '.hg', '.svn', '.nimbus', '.next', '.nuxt', '.output', '.astro',
    '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite', '.vercel', '.wrangler', 'coverage',
]);
/** $HOME-relative caches: package stores and regenerable state, not configuration. */
const HOME_EXCLUDED = [
    '.cache/', '.npm/', '.bun/install/', '.nimbus/', '.pnpm-store/', '.yarn/cache/', '.yarn/berry/', '.node-gyp/',
    '.local/share/pnpm/', '.local/state/',
];
const CONVENTION = [
    /^package\.json$/, /^(?:ts|js)config(?:\..*)?\.json$/, /^\.env(?:\..*)?$/, /^\.npmrc$/, /^\.nvmrc$/,
    /\.config\.(?:c|m)?(?:j|t)s$/, /\.config\.json$/, /^\.[\w-]+rc(?:\.(?:json|js|cjs|mjs|ya?ml|toml))?$/,
    /^(?:package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.package-lock\.json|\.modules\.yaml)$/,
    /^\.browserslistrc$/, /^\.editorconfig$/, /^\.gitignore$/,
];
function key(path) {
    return path.replace(/^\/+/, '').replace(/\/+$/, '');
}
function parentOf(k) {
    const i = k.lastIndexOf('/');
    return i < 0 ? '' : k.slice(0, i);
}
function baseOf(k) {
    return k.slice(k.lastIndexOf('/') + 1);
}
/** The `package-json` rule: a package.json anywhere but in a git directory. */
export function isManifestKey(k) {
    return baseOf(k) === 'package.json' && !k.split('/').includes('.git');
}
/** The package directory a path sits in: up to the name after its last node_modules. */
export function packageRootOf(k) {
    const at = k.lastIndexOf('node_modules/');
    if (at < 0)
        return null;
    const rest = k.slice(at + 'node_modules/'.length).split('/');
    const take = rest[0]?.startsWith('@') ? 2 : 1;
    if (rest.length <= take)
        return null;
    return k.slice(0, at) + 'node_modules/' + rest.slice(0, take).join('/');
}
/** `rel` under the canonical key `base`, a leading slash in `rel` not resetting it. */
function joinKey(base, rel) {
    return rootClampedSegments(`${base}/${rel}`).join('/');
}
/**
 * Every file a package.json names as an entry, relative to its package:
 * each subpath's `exports` targets under every condition (a dev server
 * resolves for the browser, the process for node), and `module`, `main` and
 * a string `browser`. Subpath patterns name no file until a specifier fills
 * them, so they name none here.
 */
function entryTargets(manifest) {
    const out = new Set();
    const leaves = (value) => {
        if (typeof value === 'string') {
            if (!value.includes('*'))
                out.add(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const v of value)
                leaves(v);
            return;
        }
        if (value && typeof value === 'object')
            for (const v of Object.values(value))
                leaves(v);
    };
    leaves(manifest.exports);
    for (const field of ['module', 'main', 'browser']) {
        if (typeof manifest[field] === 'string')
            out.add(manifest[field]);
    }
    if (manifest.exports === undefined && manifest.main === undefined)
        out.add('index.js');
    return [...out];
}
/** A directory's package.json, parsed once per plan; null when absent or not JSON. */
async function readManifest(source, dir, manifests) {
    let manifest = manifests.get(dir);
    if (manifest === undefined) {
        const text = await source.readText(joinKey(dir, 'package.json'));
        try {
            manifest = text === null ? null : JSON.parse(packageJsonText(text));
        }
        catch {
            manifest = null;
        }
        manifests.set(dir, manifest);
    }
    return manifest;
}
/**
 * The resolvers' filesystem (require-resolution.ts) over the plan's source,
 * each answer asked once per plan: a resolved file is the one the lookup
 * reaches through every symlink on its path (`links`), or, past
 * MAX_LINK_HOPS, the path itself, which then names nothing a stat finds.
 */
function resolutionFs(source, links) {
    const stats = new Map();
    const texts = new Map();
    const stat = (path) => {
        const k = key(path);
        let found = stats.get(k);
        if (found === undefined)
            stats.set(k, found = source.stat(k));
        return found;
    };
    return {
        exists: async (path) => (await stat(path)) !== null,
        isDirectory: async (path) => (await stat(path))?.kind === 'directory',
        readFileString: async (path) => {
            const k = key(path);
            let text = texts.get(k);
            if (text === undefined)
                texts.set(k, text = source.readText(k));
            const found = await text;
            if (found === null)
                throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
            return found;
        },
        stat: async (path) => {
            const found = await stat(path);
            return found === null ? null : { size: found.size };
        },
        realpath: async (path) => (await throughLinks(links, key(path))) ?? key(path),
    };
}
/**
 * DataPlanSource.linkTarget over a process's bridge: where the symlink at
 * `path` leads as the namespace follows it, or null when it is no link. A
 * missing or unreadable component is not a link: the lookup ends there.
 */
export async function linkTargetOf(fs, path) {
    try {
        const text = await fs.readlink(path);
        return text === null ? null : await fs.linkLeadsTo(path, text);
    }
    catch {
        return null;
    }
}
/** Symlinks a lookup follows before it gives up (Linux's MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;
/**
 * A key with every symlink along it replaced by its target, as a lookup
 * resolves it, asking the source one component at a time; null past
 * MAX_LINK_HOPS (ELOOP).
 */
async function throughLinks(source, k) {
    let path = k;
    for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
        const segs = path.split('/');
        let followed = false;
        for (let i = 1; i <= segs.length; i++) {
            const at = segs.slice(0, i).join('/');
            const target = await source.linkTarget('/' + at);
            if (target === null)
                continue;
            const base = target.startsWith('/') ? key(target) : joinKey(parentOf(at), target);
            path = joinKey(base, segs.slice(i).join('/'));
            followed = true;
            break;
        }
        if (!followed)
            return path;
    }
    return null;
}
/**
 * The plan for one launch. Walks the namespace once, in pages.
 */
export async function planFacetData(source, input) {
    const cwd = key(input.cwd);
    const home = key(input.home);
    const cwdPrefix = cwd ? cwd + '/' : '';
    const homeDot = home ? home + '/.' : '.';
    const closureRoots = new Set();
    let typescriptRoot = null;
    for (const path of input.closure) {
        const root = packageRootOf(key(path));
        if (root === null)
            continue;
        closureRoots.add(root);
        if (typescriptRoot === null && root.endsWith('node_modules/typescript'))
            typescriptRoot = root;
    }
    // Each link question once per plan: the paths it resolves share prefixes.
    const linkAnswers = new Map();
    const links = {
        linkTarget: (path) => {
            let answer = linkAnswers.get(path);
            if (answer === undefined)
                linkAnswers.set(path, answer = source.linkTarget(path));
            return answer;
        },
    };
    const conventionDirs = new Set([joinKey(cwd, 'node_modules')]);
    for (let d = cwd;; d = parentOf(d)) {
        conventionDirs.add(d);
        if (d === '')
            break;
    }
    // What the map holds as the file itself: its paths but the code-only ones.
    const closure = new Set();
    for (const path of input.closure)
        closure.add(key(path));
    for (const path of input.codeOnly ?? [])
        closure.delete(key(path));
    // Static references, as keys: each exact path, and whether any site reads
    // it synchronously.
    const exact = new Map();
    const note = (k, sync) => exact.set(k, exact.get(k) === true || sync);
    const listed = new Set();
    const patterns = [];
    const manifests = new Map();
    for (const refs of input.refs) {
        for (const r of refs.exact)
            note(key(r.path), r.sync);
        for (const r of refs.cwdRelative)
            note(joinKey(cwd, r.path), r.sync);
        for (const p of refs.listed)
            listed.add(key(p));
        for (const p of refs.patterns)
            patterns.push({ dir: key(p.dir), prefix: p.prefix, suffix: p.suffix });
    }
    const learned = new Set();
    for (const p of input.learned ?? [])
        learned.add(key(p));
    const rules = Object.fromEntries(['package-json', 'project', 'convention', 'package-data', 'home', 'typescript', 'static', 'entries', 'learned']
        .map((r) => [r, { files: 0, bytes: 0 }]));
    const paths = [];
    const planned = new Set();
    let bytes = 0;
    const take = (entry, rule) => {
        if (planned.has(entry.path))
            return;
        planned.add(entry.path);
        paths.push(entry.path);
        bytes += entry.size;
        rules[rule].files++;
        rules[rule].bytes += entry.size;
    };
    // Directories a reference expands to: a listed directory.
    const expanded = new Set();
    const underExpanded = (k) => {
        for (let d = parentOf(k); d !== ''; d = parentOf(d)) {
            if (expanded.has(d))
                return true;
            if (baseOf(d) === 'node_modules')
                return false;
        }
        return false;
    };
    const homeKept = (k) => {
        const rel = k.slice(home ? home.length + 1 : 0) + '/';
        return !HOME_EXCLUDED.some((prefix) => rel.startsWith(prefix));
    };
    /**
     * Whether a file lies in a dependency, VCS or cache directory below `dir`,
     * or in a cache of the home directory it is in ($HOME, or /home/<user>).
     */
    const excludedBelow = (dir, k) => {
        const rel = k.slice(dir === '' ? 0 : dir.length + 1).split('/');
        if (rel.slice(0, -1).some((seg) => PROJECT_EXCLUDED.has(seg)))
            return true;
        const segs = k.split('/');
        const userHome = home !== '' && k.startsWith(home + '/') ? home
            : segs[0] === 'home' && segs.length > 2 ? 'home/' + segs[1] : null;
        if (userHome === null)
            return false;
        const inHome = k.slice(userHome.length + 1) + '/';
        return HOME_EXCLUDED.some((prefix) => inHome.startsWith(prefix));
    };
    /**
     * Whether a file is one a pattern `dir/prefix*suffix` can name. A hole with
     * a known prefix or suffix fills one name in `dir`: a file there, or the
     * files directly in a directory there. A bare hole under a
     * named directory (`join(dir, x)`) may be a relative path of any depth: the
     * directory's files, minus dependency, VCS and cache directories. A bare
     * hole at the root (`'/' + x`) names the whole filesystem, which nothing
     * static bounds: it matches nothing and the read is a run-time one.
     */
    const patternMatch = (k) => {
        const dir = parentOf(k);
        const name = baseOf(k);
        for (const p of patterns) {
            if (p.prefix === '' && p.suffix === '') {
                if (p.dir !== '' && k.startsWith(p.dir + '/') && !excludedBelow(p.dir, k))
                    return true;
                continue;
            }
            const named = (n) => n.startsWith(p.prefix) && n.endsWith(p.suffix) && n.length >= p.prefix.length + p.suffix.length;
            if (p.dir === dir && named(name))
                return true;
            // A matched name may be a directory the code lists: its own files, one level.
            if (dir !== '' && p.dir === parentOf(dir) && named(baseOf(dir)) && !excludedBelow(p.dir, k))
                return true;
        }
        return false;
    };
    const declarations = [];
    const packageRoots = new Set();
    // Directories a home or project symlink points at, whose files the rule
    // that took the link would have taken had they been in place.
    const linkedDirs = [];
    /**
     * A statically named file is worth holding when the module map does not
     * already hold it, and it is data-sized or the code reads it synchronously
     * by that name: such a read cannot wait for bytes of any size. Its bytes
     * count toward the plan's storage, which the launch admits or refuses.
     */
    /** Sync-read paths the walk found as files under their own name. */
    const seenFiles = new Set();
    const staticWorthy = (entry) => !closure.has(entry.path)
        && (entry.size < PACKAGE_DATA_MAX_BYTES || exact.get(entry.path) === true);
    let after = null;
    for (;;) {
        const page = await source.list(after);
        if (input.spend)
            await input.spend(page.entries.length * 64);
        for (const raw of page.entries) {
            const k = key(raw.path);
            const entry = { path: k, kind: raw.kind, size: raw.size };
            if (entry.kind === 'directory') {
                if (listed.has(k))
                    expanded.add(k);
                if (packageRootOf(k + '/x') === k)
                    packageRoots.add(k);
                continue;
            }
            const segs = k.split('/');
            if (entry.kind === 'symlink') {
                // A package linked into node_modules (pnpm's, a workspace's) is installed there.
                if (packageRootOf(k + '/x') === k)
                    packageRoots.add(k);
                if (raw.linkTarget === undefined)
                    continue;
                const inProject = (cwdPrefix === '' || k.startsWith(cwdPrefix))
                    && !(cwdPrefix === '' ? segs : k.slice(cwdPrefix.length).split('/')).slice(0, -1).some((x) => PROJECT_EXCLUDED.has(x));
                const inHome = k.startsWith(homeDot) && homeKept(k) && !segs.includes('node_modules');
                if (inProject || inHome) {
                    const target = raw.linkTarget.startsWith('/') ? key(raw.linkTarget) : joinKey(parentOf(k), raw.linkTarget);
                    linkedDirs.push({ target, rule: inProject ? 'project' : 'home' });
                }
                continue;
            }
            if (entry.kind !== 'file')
                continue;
            if (exact.get(k) === true)
                seenFiles.add(k);
            const name = baseOf(k);
            if (isManifestKey(k)) {
                take(entry, 'package-json');
                continue;
            }
            if (cwdPrefix === '' || k.startsWith(cwdPrefix)) {
                const rel = cwdPrefix === '' ? segs : k.slice(cwdPrefix.length).split('/');
                if (!rel.slice(0, -1).some((s) => PROJECT_EXCLUDED.has(s))) {
                    take(entry, 'project');
                    continue;
                }
            }
            if (conventionDirs.has(parentOf(k)) && CONVENTION.some((re) => re.test(name))) {
                take(entry, 'convention');
                continue;
            }
            const root = packageRootOf(k);
            if (root !== null && closureRoots.has(root) && !CODE_FILE.test(name) && entry.size < PACKAGE_DATA_MAX_BYTES
                && !k.slice(root.length + 1).includes('node_modules/')) {
                take(entry, 'package-data');
                continue;
            }
            if (k.startsWith(homeDot) && homeKept(k) && !segs.includes('node_modules') && !segs.includes('.git')) {
                take(entry, 'home');
                continue;
            }
            if (typescriptRoot !== null) {
                if (root === typescriptRoot && parentOf(k) === typescriptRoot + '/lib' && /^lib\..*\.d\.ts$/.test(name)) {
                    take(entry, 'typescript');
                    continue;
                }
                if (k.includes('node_modules/@types/')) {
                    take(entry, 'typescript');
                    continue;
                }
                if (root !== null && DECLARATION_FILE.test(name))
                    declarations.push(entry);
            }
            if ((exact.has(k) || listed.has(parentOf(k)) || patternMatch(k) || underExpanded(k)) && staticWorthy(entry)) {
                take(entry, 'static');
                continue;
            }
            if (learned.has(k)) {
                take(entry, 'learned');
                continue;
            }
        }
        if (page.next === null)
            break;
        after = page.next;
    }
    // What @types depends on (undici-types for @types/node): their declarations.
    if (typescriptRoot !== null && declarations.length > 0) {
        const typeDeps = new Set();
        const typesRoots = new Set();
        for (const p of paths) {
            if (!p.endsWith('/package.json') || !p.includes('node_modules/@types/'))
                continue;
            const root = packageRootOf(p);
            if (root !== null && root + '/package.json' === p)
                typesRoots.add(root);
        }
        for (const root of typesRoots) {
            const text = await source.readText(root + '/package.json');
            try {
                const deps = JSON.parse(packageJsonText(text ?? '{}')).dependencies ?? {};
                for (const dep of Object.keys(deps))
                    typeDeps.add(dep);
            }
            catch { /* not a manifest */ }
        }
        for (const entry of declarations) {
            const root = packageRootOf(entry.path);
            const name = root.slice(root.lastIndexOf('node_modules/') + 'node_modules/'.length);
            if (typeDeps.has(name))
                take(entry, 'typescript');
        }
    }
    // A synchronous read of a path through a symlink reads the file the link
    // leads to, which the walk saw under its own name: hold that file. Only
    // such a read's own path is resolved, one component at a time; the
    // namespace's links are never collected.
    for (const [k, sync] of exact) {
        if (!sync || planned.has(k) || seenFiles.has(k))
            continue;
        const target = await throughLinks(links, k);
        if (target === null || target === k || planned.has(target))
            continue;
        const found = await source.stat(target);
        if (found === null || found.kind !== 'file')
            continue;
        const entry = { path: target, kind: 'file', size: found.size };
        if (!closure.has(target))
            take(entry, 'static');
    }
    const files = resolutionFs(source, links);
    const conditions = input.conditions ?? [];
    const projectManifest = await readManifest(source, cwd, manifests);
    /** Where Node finds package \`name\` from \`from\`: its own node_modules, then each ancestor's. */
    const installedFrom = (from, name) => {
        for (let d = from;; d = parentOf(d)) {
            if (baseOf(d) !== 'node_modules' && packageRoots.has(joinKey(d, 'node_modules/' + name)))
                return joinKey(d, 'node_modules/' + name);
            if (d === '')
                return null;
        }
    };
    // What the closure's code resolves, as its readers resolve it
    // (require-resolution.ts, esm-resolver.ts, exports-resolver.ts): a
    // require.resolve names the file Node's require resolves, under the
    // program's conditions; a package subpath spelled as data names what any
    // of its readers would, Node's import and require and a bundler's
    // (import, module, browser). A bare specifier is looked up only where its
    // package is installed on its lookup path, or is the project's own.
    const lookedUp = (from, spec) => {
        if (/^(?:\.\.?(?:\/|$)|\/|#)/.test(spec))
            return true;
        const name = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
        return name === projectManifest?.name || installedFrom(from, name) !== null;
    };
    const bundled = async (from, spec) => {
        const at = spec.indexOf('/', spec.startsWith('@') ? spec.indexOf('/') + 1 : 0);
        const pkgDir = installedFrom(from, at < 0 ? spec : spec.slice(0, at));
        const text = pkgDir === null ? null : await source.readText(pkgDir + '/package.json');
        const pkg = text === null ? null : parseResolvablePackageJson(text);
        const target = pkg === null ? null : resolvePackageEntry(pkg, at < 0 ? '.' : '.' + spec.slice(at));
        return pkgDir === null || target === null ? null : await throughLinks(links, joinKey(pkgDir, target));
    };
    const hold = async (k) => {
        if (k === null || planned.has(k))
            return;
        const found = await source.stat(k);
        if (found === null || found.kind !== 'file')
            return;
        const entry = { path: k, kind: 'file', size: found.size };
        if (staticWorthy(entry))
            take(entry, 'static');
    };
    for (const refs of input.refs) {
        for (const r of refs.resolves) {
            const from = key(r.from);
            if (!lookedUp(from, r.spec))
                continue;
            await hold(await resolveDeferredImport(files, { specifier: r.spec, fromDir: from, alternatives: 1, require: true }, undefined, conditions));
        }
        for (const r of refs.subpaths) {
            const from = key(r.from);
            if (!lookedUp(from, r.spec))
                continue;
            await hold(await resolveDeferredImport(files, { specifier: r.spec, fromDir: from, alternatives: 1, require: true }, undefined, conditions));
            await hold(await resolveDeferredImport(files, { specifier: r.spec, fromDir: from, alternatives: 1 }, undefined, conditions));
            await hold(await bundled(from, r.spec));
        }
    }
    // The entries of the working dir's dependencies and of theirs, each the
    // file Node's resolver loads for it (require-resolution.ts, as the
    // module-map walk resolves): a `main` without its extension, or naming a
    // directory with a package.json of its own. A dev server pre-bundles what
    // the app imports, and what a framework asks it to on its own behalf: its
    // own dependencies, named `astro > aria-query` in Vite's
    // optimizeDeps.include and found from where the framework is installed.
    // Astro's dev toolbar includes aria-query, axobject-query and
    // html-escaper; their entries were held only when an earlier session's
    // miss had been learned for them, so a fresh or concurrent launch's
    // optimizer read them synchronously and failed.
    const declared = (manifest, fields) => {
        const names = [];
        for (const field of fields) {
            const named = manifest?.[field];
            if (named && typeof named === 'object')
                names.push(...Object.keys(named));
        }
        return names;
    };
    const dependencyDirs = new Set();
    for (const name of declared(projectManifest, ['dependencies', 'devDependencies', 'optionalDependencies'])) {
        const pkgDir = installedFrom(cwd, name);
        if (pkgDir !== null)
            dependencyDirs.add(pkgDir);
    }
    for (const pkgDir of [...dependencyDirs]) {
        // Installed beside or below the package that names them; its dev
        // dependencies are not installed at all.
        const own = await readManifest(source, pkgDir, manifests);
        for (const name of declared(own, ['dependencies', 'optionalDependencies', 'peerDependencies'])) {
            const depDir = installedFrom(pkgDir, name);
            if (depDir !== null)
                dependencyDirs.add(depDir);
        }
    }
    for (const pkgDir of dependencyDirs) {
        const manifest = await readManifest(source, pkgDir, manifests);
        if (manifest === null)
            continue;
        for (const rel of entryTargets(manifest)) {
            const k = await resolveFile(files, joinKey(pkgDir, rel));
            if (k === null)
                continue;
            const found = await source.stat(k);
            if (found === null || found.kind !== 'file')
                continue;
            if (found.size < PACKAGE_DATA_MAX_BYTES && !closure.has(k))
                take({ path: k, kind: 'file', size: found.size }, 'entries');
        }
    }
    // The files behind symlinked directories the project or home rule reached.
    if (linkedDirs.length > 0) {
        after = null;
        for (;;) {
            const page = await source.list(after);
            if (input.spend)
                await input.spend(page.entries.length * 64);
            for (const raw of page.entries) {
                if (raw.kind !== 'file')
                    continue;
                const k = key(raw.path);
                for (const { target, rule } of linkedDirs) {
                    if (k === target || k.startsWith(target + '/')) {
                        if (!k.slice(target.length).split('/').some((x) => x === 'node_modules' || x === '.git')) {
                            take({ path: k, kind: 'file', size: raw.size }, rule);
                        }
                        break;
                    }
                }
            }
            if (page.next === null)
                break;
            after = page.next;
        }
    }
    return { paths, bytes, rules };
}
