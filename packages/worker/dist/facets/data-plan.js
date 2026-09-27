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
function joinKey(base, rel) {
    const out = base ? base.split('/') : [];
    for (const seg of rel.split('/')) {
        if (seg === '' || seg === '.')
            continue;
        if (seg === '..')
            out.pop();
        else
            out.push(seg);
    }
    return out.join('/');
}
/** One `exports` target: a string, or the first usable branch of a conditions object. */
function exportTarget(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        for (const v of value) {
            const t = exportTarget(v);
            if (t)
                return t;
        }
        return null;
    }
    if (value && typeof value === 'object') {
        for (const cond of ['node', 'import', 'module', 'default', 'require']) {
            if (cond in value) {
                const t = exportTarget(value[cond]);
                if (t)
                    return t;
            }
        }
    }
    return null;
}
/** Map `./sub` through a package.json `exports` field; null when it does not export it. */
function mapExports(exportsField, sub) {
    if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
        return sub === '.' ? exportTarget(exportsField) : null;
    }
    const table = exportsField;
    if (!Object.keys(table).some((k) => k.startsWith('.')))
        return sub === '.' ? exportTarget(table) : null;
    if (sub in table)
        return exportTarget(table[sub]);
    let best = null;
    for (const [pattern, target] of Object.entries(table)) {
        const star = pattern.indexOf('*');
        if (star < 0)
            continue;
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (!sub.startsWith(prefix) || !sub.endsWith(suffix) || sub.length < prefix.length + suffix.length)
            continue;
        if (!best || prefix.length > best.prefix.length)
            best = { prefix, suffix, target };
    }
    if (!best)
        return null;
    const t = exportTarget(best.target);
    if (!t)
        return null;
    return t.replaceAll('*', sub.slice(best.prefix.length, sub.length - best.suffix.length));
}
async function resolveSpecifier(source, fromDir, spec, manifests) {
    const parts = spec.split('/');
    const nameLen = spec.startsWith('@') ? 2 : 1;
    if (parts.length < nameLen)
        return null;
    const name = parts.slice(0, nameLen).join('/');
    const sub = parts.slice(nameLen).join('/');
    for (let dir = fromDir;; dir = parentOf(dir)) {
        if (baseOf(dir) !== 'node_modules') {
            const pkgDir = joinKey(dir, 'node_modules/' + name);
            let manifest = manifests.get(pkgDir);
            if (manifest === undefined) {
                const text = await source.readText(pkgDir + '/package.json');
                try {
                    manifest = text === null ? null : JSON.parse(text);
                }
                catch {
                    manifest = null;
                }
                manifests.set(pkgDir, manifest);
            }
            if (manifest) {
                const mapped = manifest.exports !== undefined ? mapExports(manifest.exports, sub ? './' + sub : '.') : null;
                if (mapped)
                    return joinKey(pkgDir, mapped);
                return sub ? joinKey(pkgDir, sub) : null;
            }
        }
        if (dir === '')
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
            const target = await source.readlink('/' + at);
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
    const conventionDirs = new Set([joinKey(cwd, 'node_modules')]);
    for (let d = cwd;; d = parentOf(d)) {
        conventionDirs.add(d);
        if (d === '')
            break;
    }
    const closure = new Set();
    for (const path of input.closure)
        closure.add(key(path));
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
    const rules = Object.fromEntries(['package-json', 'project', 'convention', 'package-data', 'home', 'typescript', 'static', 'learned']
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
            if (name === 'package.json' && !segs.includes('.git')) {
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
                const deps = JSON.parse(text ?? '{}').dependencies ?? {};
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
        const target = await throughLinks(source, k);
        if (target === null || target === k || planned.has(target))
            continue;
        const found = await source.stat(target);
        if (found === null || found.kind !== 'file')
            continue;
        const entry = { path: target, kind: 'file', size: found.size };
        if (!closure.has(target))
            take(entry, 'static');
    }
    // Specifiers resolve through package.json files, so only those whose
    // package exists are looked up.
    for (const refs of input.refs) {
        for (const r of refs.resolves) {
            const name = r.spec.split('/').slice(0, r.spec.startsWith('@') ? 2 : 1).join('/');
            let exists = false;
            for (let d = key(r.from); !exists; d = parentOf(d)) {
                if (packageRoots.has(joinKey(d, 'node_modules/' + name)))
                    exists = true;
                if (d === '')
                    break;
            }
            if (!exists)
                continue;
            const resolved = await resolveSpecifier(source, key(r.from), r.spec, manifests);
            if (resolved === null || planned.has(resolved))
                continue;
            const found = await source.stat(resolved);
            if (found === null || found.kind !== 'file')
                continue;
            const entry = { path: resolved, kind: 'file', size: found.size };
            if (staticWorthy(entry))
                take(entry, 'static');
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
