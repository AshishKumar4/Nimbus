/**
 * npm-tree.ts — the vocabulary of npm's one install engine, shared by the
 * engine (npm-arborist/, which builds the tree) and its two hosts (worker
 * npm/installer.ts and lifo commands/system/npm.ts): placements, manifests
 * and their edges, a project's roots, what the command line names and how it
 * is saved, and one install into a tree at a time.
 *
 * Placements are paths relative to the project's node_modules: `react` at
 * root, `pkg/node_modules/dep` nested. Node walks node_modules upward from
 * the importer, so a nested copy is found by its dependent and what is
 * beneath it, and by nobody else.
 */
import { isExactVersion, isSemverRange, rangeSubset, rangesIntersect, satisfiesRange } from './npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from './npm-spec.js';
import { LruMap } from './lru-map.js';
import { z } from 'zod/v4';
// ── Placements ───────────────────────────────────────────────────────────────
const NM = '/node_modules/';
/** The containing placement, `''` at root. */
export function parentPlacement(placement) {
    const i = placement.lastIndexOf(NM);
    return i < 0 ? '' : placement.slice(0, i);
}
/** The package name a placement holds. */
export function placementName(placement) {
    const i = placement.lastIndexOf(NM);
    return i < 0 ? placement : placement.slice(i + NM.length);
}
/** How deep a placement is: 1 at root. */
export function depthOf(placement) {
    return placement === '' ? 0 : placement.split(NM).length;
}
/**
 * A cycle with mutually incompatible ranges has no finite layout without
 * links: a request that would nest deeper than this fails rather than
 * nesting without end.
 */
export const MAX_NEST_DEPTH = 16;
/** The names a manifest bundles: its `bundleDependencies` list, or every dependency for `true`. They are not resolved, nor deduped away. */
export function bundledNames(manifest) {
    const declared = manifest.bundleDependencies;
    if (declared === true)
        return Object.keys(manifest.dependencies ?? {});
    return Array.isArray(declared) ? declared.filter((name) => typeof name === 'string') : [];
}
/** A peer edge: placed with the package that asks for it. */
export function isPeer(type) {
    return type === 'peer' || type === 'peerOptional';
}
/** An optional edge: its failure is no failure of the package that asks for it. */
export function isOptional(type) {
    return type === 'optional' || type === 'peerOptional';
}
/**
 * The edges a manifest asks for, as npm's Node loads them (_loadDeps), the
 * later replacing the earlier of one name: its peers (an optional one is
 * peerOptional: not installed where absent, and constraining where present),
 * then its dependencies, then its optional dependencies. `legacyPeerDeps`:
 * peers are not loaded at all.
 */
export function manifestEdges(manifest, { legacyPeerDeps = false } = {}) {
    const byName = new Map();
    if (!legacyPeerDeps) {
        const meta = manifest.peerDependenciesMeta ?? {};
        for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
            byName.set(name, { name, range, type: meta[name]?.optional === true ? 'peerOptional' : 'peer' });
        }
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
        byName.set(name, { name, range, type: 'prod' });
    for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {}))
        byName.set(name, { name, range, type: 'optional' });
    return [...byName.values()];
}
/** Each spec parsed once, by `name\0spec`. */
const edgeRequests = new LruMap(8192);
export function edgeRequest(name, spec) {
    const key = `${name}\0${spec}`;
    let request = edgeRequests.get(key);
    if (request === undefined) {
        const { registryName, range, registry } = parseRegistryRequest(name, spec);
        const trimmed = range.trim();
        request = { registryName, range: isSemverRange(trimmed) && trimmed !== '*' && trimmed !== '' ? trimmed : null, registry };
        edgeRequests.set(key, request);
    }
    return request;
}
/** Each version tested against each range once, by `version\0range`. */
const satisfied = new LruMap(65536);
/** Whether `version` meets an edge's range, as npm's dep-valid reckons it: any version, for a spec that is not a range. */
export function meets(version, edge) {
    const { range } = edgeRequest(edge.name, edge.range);
    if (range === null)
        return true;
    const key = `${version}\0${range}`;
    let answer = satisfied.get(key);
    if (answer === undefined) {
        answer = satisfiesRange(version, range);
        satisfied.set(key, answer);
    }
    return answer;
}
/** A dependency field as npm reads it: its string ranges (an entry of another shape names no dependency). */
const DependencyMapSchema = z.record(z.string(), z.unknown()).transform((map) => Object.fromEntries(Object.entries(map).flatMap(([name, range]) => (typeof range === 'string' ? [[name, range]] : []))));
const ProjectManifestSchema = z.object({
    dependencies: DependencyMapSchema.optional().catch(undefined),
    devDependencies: DependencyMapSchema.optional().catch(undefined),
    optionalDependencies: DependencyMapSchema.optional().catch(undefined),
    peerDependencies: DependencyMapSchema.optional().catch(undefined),
    peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional().catch(undefined) }).catch({})).optional().catch(undefined),
    bundleDependencies: z.unknown().optional(),
    bundledDependencies: z.unknown().optional(),
}).transform(({ bundleDependencies, bundledDependencies, ...manifest }) => {
    const bundle = bundleDependencies ?? bundledDependencies;
    return bundle === undefined ? manifest : { ...manifest, bundleDependencies: bundle };
});
const PackageJsonSchema = z.record(z.string(), z.unknown());
/** A parsed package.json; null where it is not an object. */
export function packageJsonDocument(value) {
    const json = PackageJsonSchema.safeParse(value);
    if (!json.success || Array.isArray(value))
        return null;
    return { json: json.data, manifest: ProjectManifestSchema.parse(json.data) };
}
/** package.json's text, read; null where it is not JSON, or not an object. */
export function readPackageJson(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    return packageJsonDocument(value);
}
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SAVE_FIELD = {
    prod: 'dependencies', dev: 'devDependencies', optional: 'optionalDependencies', peer: 'peerDependencies', peerOptional: 'peerDependencies',
};
/** The save type npm infers for `name` from where the project declares it (add-rm-pkg-deps inferSaveType); prod when it does not. */
export function inferSaveType(manifest, name) {
    for (const type of ['dev', 'optional', 'prod', 'peerOptional']) {
        if (manifest?.[SAVE_FIELD[type]]?.[name] === undefined)
            continue;
        if (type === 'peerOptional' && manifest.peerDependenciesMeta?.[name]?.optional !== true)
            return 'peer';
        return type;
    }
    return 'prod';
}
/**
 * The packages a command line names, as npm adds them: each saved where the
 * flags say (`--save-dev`, `--save-optional`), else where the project
 * already declares it; a bare name (or `*`) the project declares keeps the
 * declared spec.
 */
export function namedPackages(manifest, specs, flags = {}) {
    return specs.map((spec) => {
        const { name, range } = splitPackageSpec(spec);
        const explicit = flags.saveDev === true || flags.saveOptional === true;
        const saveType = flags.saveDev ? 'dev' : flags.saveOptional ? 'optional' : inferSaveType(manifest, name);
        const declared = manifest?.[SAVE_FIELD[saveType]]?.[name];
        return { name, range: (range === null || range === '*') && declared !== undefined ? declared : range, saveType, explicit };
    });
}
/**
 * A project's roots, as npm's Node loads the root's edges, the later
 * replacing the earlier of one name: its peers, dependencies and optional
 * dependencies (manifestEdges), then its devDependencies; then the packages
 * named on the command line, explicit requests of their save type. The
 * tree is planned whole: `--omit=dev` leaves out at reification what only
 * devDependencies reach (TreePlan.omits). A global prefix has no manifest:
 * its roots are what the command line names.
 */
export function projectRoots(manifest, named, { legacyPeerDeps = false } = {}) {
    const roots = new Map();
    for (const edge of manifestEdges(manifest ?? {}, { legacyPeerDeps }))
        roots.set(edge.name, edge);
    for (const [name, range] of Object.entries(manifest?.devDependencies ?? {}))
        roots.set(name, { name, range, type: 'dev' });
    for (const { name, range, saveType } of named)
        roots.set(name, { name, range: range ?? 'latest', type: saveType, explicit: true });
    return [...roots.values()];
}
/**
 * Whether a lock's root (`lockRoot`, its package.json fields) declares what
 * the project's `roots` are (load-virtual checkRootEdges): every dependency
 * of every type it records is a root of that type at that spec, and there
 * is no other root.
 */
export function lockRootMatches(lockRoot, roots) {
    const byName = new Map(roots.map((root) => [root.name, root]));
    const optional = lockRoot.optionalDependencies ?? {};
    const peers = Object.entries(lockRoot.peerDependencies ?? {});
    const optionalPeer = ([name]) => lockRoot.peerDependenciesMeta?.[name]?.optional === true;
    const declared = [
        ['dev', Object.entries(lockRoot.devDependencies ?? {})],
        ['optional', Object.entries(optional)],
        ['peer', peers.filter((entry) => !optionalPeer(entry))],
        ['peerOptional', peers.filter(optionalPeer)],
        ['prod', Object.entries(lockRoot.dependencies ?? {}).filter(([name]) => !Object.hasOwn(optional, name))],
    ];
    const seen = new Set();
    for (const [type, entries] of declared) {
        for (const [name, spec] of entries) {
            const root = byName.get(name);
            if (root?.type !== type || root.range !== spec)
                return false;
            seen.add(name);
        }
    }
    return seen.size === byName.size;
}
/**
 * package.json (`json`, as parsed) with what the command line named saved,
 * as npm saves it: first added where its save type goes and out of the
 * fields that type excludes (add-rm-pkg-deps add), then, once it installed
 * (`installed`: the version under its name), saved at `^version` unless the
 * spec given is a range `^version` would widen, an alias as the package it
 * names (reify #saveIdealTree). An explicit save type writes that field; an
 * inferred one updates every field that names it, but a peer or optional
 * range a dev one still intersects. One that did not install keeps the
 * spec given. As npm writes package.json, a name in optionalDependencies is
 * not repeated in dependencies. Every other field is as it was.
 */
export function saveNamed(json, named, installed, 
/** npm's save-prefix: '' for `--save-exact`. */
savePrefix = '^') {
    const declared = ProjectManifestSchema.parse(json);
    const fields = new Map();
    const field = (key) => {
        let map = fields.get(key);
        if (map === undefined) {
            map = { ...declared[key] };
            fields.set(key, map);
        }
        return map;
    };
    const has = (key, name) => field(key)[name] !== undefined;
    for (const { name, range, saveType, explicit } of named) {
        // add-rm-pkg-deps add: the spec as given, where its save type goes.
        const drop = saveType === 'prod' ? ['devDependencies', 'peerDependencies']
            : saveType === 'dev' ? ['dependencies']
                : saveType === 'optional' ? ['peerDependencies']
                    : ['dependencies', 'optionalDependencies'];
        for (const key of drop)
            if (has(key, name))
                delete field(key)[name];
        const spec = range ?? '*';
        const target = field(SAVE_FIELD[saveType]);
        if (spec !== '*' || target[name] === undefined)
            target[name] = spec;
        if ((saveType === 'peer' || saveType === 'peerOptional') && has('devDependencies', name))
            field('devDependencies')[name] = target[name];
        // reify #saveIdealTree: the installed version.
        const version = installed(name);
        if (version === null)
            continue;
        const { range: requested, alias, registryName } = parseRegistryRequest(name, spec);
        const prefixed = `${savePrefix}${version}`;
        const isRange = isSemverRange(requested) && !isExactVersion(requested) && requested !== '*' && requested !== '' && requested !== 'latest';
        const savedRange = isRange && !rangeSubset(prefixed, requested) ? requested : prefixed;
        // Alias syntax where the package is another's (reify #saveIdealTree reads the child's packageName).
        const saved = alias && registryName !== name ? `npm:${registryName}@${savedRange}` : savedRange;
        if (explicit) {
            target[name] = saved;
            if (saveType === 'prod' && has('optionalDependencies', name))
                delete field('optionalDependencies')[name];
            continue;
        }
        if (has('dependencies', name))
            field('dependencies')[name] = saved;
        const updates = (key) => has(key, name) && (!has('devDependencies', name) || !rangesIntersect(saved, field(key)[name]));
        const peer = updates('peerDependencies');
        const optional = updates('optionalDependencies');
        if (has('devDependencies', name))
            field('devDependencies')[name] = saved;
        if (peer)
            field('peerDependencies')[name] = saved;
        if (optional)
            field('optionalDependencies')[name] = saved;
    }
    const optional = fields.get('optionalDependencies') ?? declared.optionalDependencies ?? {};
    for (const name of Object.keys(optional))
        if ((fields.get('dependencies') ?? declared.dependencies)?.[name] !== undefined)
            delete field('dependencies')[name];
    return { ...json, ...Object.fromEntries(fields) };
}
// ── One install into a tree at a time ────────────────────────────────────────
/**
 * Installs into one node_modules tree, one at a time, in the order they
 * asked. Keyed by the tree's namespace (a workspace's kernel, a session's
 * store) and its canonical path there, so two paths to one tree (a prefix
 * through a symlink) are one queue. A held tree's entry lists who waits for
 * it next.
 */
const heldTrees = new WeakMap();
/**
 * Hold the tree at `canonical` in `namespace` for one install, and give it
 * back with the release this answers, once the install is done: at once
 * when no install holds it, else (a promise) once those before have given it
 * back. One that `signal` stops while it waits never holds it (an AbortError).
 */
export function holdTree(namespace, canonical, signal) {
    const held = heldTrees.get(namespace) ?? new Map();
    if (held.size === 0)
        heldTrees.set(namespace, held);
    const release = () => {
        const next = held.get(canonical)?.shift();
        if (next === undefined)
            held.delete(canonical);
        else
            next();
    };
    const waiting = held.get(canonical);
    if (waiting === undefined) {
        if (signal?.aborted)
            return Promise.reject(signal.reason);
        held.set(canonical, []);
        return release;
    }
    return new Promise((resolve, reject) => {
        const admit = () => {
            signal?.removeEventListener('abort', abandon);
            resolve(release);
        };
        const abandon = () => {
            const at = waiting.indexOf(admit);
            if (at >= 0)
                waiting.splice(at, 1);
            reject(signal?.reason);
        };
        if (signal?.aborted)
            return abandon();
        signal?.addEventListener('abort', abandon, { once: true });
        waiting.push(admit);
    });
}
/**
 * Where `path` is: its deepest existing ancestor resolved through symlinks
 * (`realpath`), and the rest of it, which does not exist yet.
 */
export async function canonicalTreePath(realpath, path) {
    let existing = path;
    let rest = '';
    while (existing !== '/' && existing !== '') {
        try {
            return (await realpath(existing)).replace(/\/+$/, '') + rest;
        }
        catch {
            const slash = existing.lastIndexOf('/');
            rest = existing.slice(slash) + rest;
            existing = slash > 0 ? existing.slice(0, slash) : '/';
        }
    }
    return rest || '/';
}
