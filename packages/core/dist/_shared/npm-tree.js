/**
 * npm-tree.ts — npm's one install engine: the ideal tree a project's roots
 * need, built as npm's arborist builds it (build-ideal-tree, place-dep,
 * can-place-dep, calc-dep-flags, optional-set), from what a host answers.
 * Both hosts install through it: the worker's (worker npm/installer.ts:
 * resolver facets a layer at a time, its lockfile for what is installed) and
 * the shell's own (lifo commands/system/npm.ts shellInstallPort: the
 * registry one package at a time, node_modules for what is installed).
 *
 * Placements are paths relative to the project's node_modules: `react` at
 * root, `pkg/node_modules/dep` nested. Node walks node_modules upward from
 * the importer, so a nested copy is found by its dependent and what is
 * beneath it, and by nobody else.
 *
 * The walk is breadth-first, a layer at a time, each layer's edges in npm's
 * order (by the dependent's depth and path, then by name). An edge already
 * met by the copy Node's walk finds from its dependent stays as it is; any
 * other, and every edge the command line names (an explicit request), is
 * resolved and placed as PlaceDep places it: from the dependent (a peer:
 * from the dependent's parent) up toward the root, at the highest place
 * where it does not conflict. A copy there that the new one may replace (it
 * is no newer, and everything relying on it accepts the new one) is
 * replaced; one that already meets the edge is kept; a copy the new one
 * would shadow from something beneath that needs it is a conflict. What is
 * installed is read as the walk reaches it: a copy no edge meets is not part
 * of the tree, and goes.
 *
 * A request that cannot be met (unresolved, refused, too deep, a peer
 * conflict with the project's own dependency) is a failure of that request,
 * not of its place: another request for the same name places on its own. A
 * placement is required when a path of required edges reaches it from the
 * project; the rest is optional. A required failure fails the install; an
 * optional one is left out with its optional set (optional-set.js): what
 * needs it up to the optionalDependencies edges into the set, and what only
 * those need.
 */
import { isExactVersion, isSemverRange, rangeSubset, satisfiesRange, versionAtLeast } from './npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from './npm-spec.js';
// ── Placements ───────────────────────────────────────────────────────────────
const NM = '/node_modules/';
/** `name` under `parent`; `''` is the project itself. */
export function nestedPlacement(parent, name) {
    return parent ? `${parent}${NM}${name}` : name;
}
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
/** Placements Node's walk visits for `name` from inside `from`, nearest first, root last. */
export function visiblePlacements(from, name) {
    const out = [];
    let dir = from;
    while (dir) {
        out.push(`${dir}${NM}${name}`);
        dir = parentPlacement(dir);
    }
    out.push(name);
    return out;
}
/** Whether `placement` is `ancestor` or beneath it (`''`: everything is). */
function within(placement, ancestor) {
    return ancestor === '' || placement === ancestor || placement.startsWith(ancestor + NM);
}
/**
 * A cycle with mutually incompatible ranges has no finite layout without
 * links: a request that would nest deeper than this fails rather than
 * nesting without end.
 */
export const MAX_NEST_DEPTH = 16;
/**
 * The edges a manifest asks for from `from`, as npm's Node loads them: the
 * peers it requires, then its dependencies, then its optional dependencies
 * (an optionalDependencies entry replaces a dependencies one).
 */
export function manifestEdges(manifest, from) {
    const byName = new Map();
    const optionalPeers = manifest.peerDependenciesMeta ?? {};
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (optionalPeers[name]?.optional !== true)
            byName.set(name, { name, range, from, kind: 'peer', optional: false, explicit: false });
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
        byName.set(name, { name, range, from, kind: 'dep', optional: false, explicit: false });
    for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {}))
        byName.set(name, { name, range, from, kind: 'dep', optional: true, explicit: false });
    return [...byName.values()];
}
/** Whether `version` meets an edge's `range`: any version, for a range that is not semver (a tag, a URL). */
function meets(version, edge) {
    const { range } = parseRegistryRequest(edge.name, edge.range);
    return !isSemverRange(range) || satisfiesRange(version, range);
}
/** Whether a parsed package.json is a manifest: a JSON object (an array is not). */
export function isManifest(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
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
        const saveType = flags.saveDev ? 'dev' : flags.saveOptional ? 'optional' : inferSaveType(manifest, name);
        const declared = manifest?.[SAVE_FIELD[saveType]]?.[name];
        return { name, range: (range === null || range === '*') && declared !== undefined ? declared : range, saveType };
    });
}
/**
 * A project's roots, as npm's Node loads its edges, the later replacing the
 * earlier of one name: its required peers, its dependencies, its optional
 * dependencies, its devDependencies (unless `production`); then the packages
 * named on the command line, explicit requests, optional where they are
 * saved as optional. `implicit`: names the project needs without declaring
 * them (a global prefix's installed packages), each met by what is there.
 */
export function projectRoots(manifest, named, { production = false, implicit = [] } = {}) {
    const roots = new Map();
    for (const name of implicit)
        roots.set(name, { name, range: '*' });
    for (const edge of manifestEdges(manifest ?? {}, ''))
        roots.set(edge.name, { name: edge.name, range: edge.range, optional: edge.optional });
    if (!production) {
        for (const [name, range] of Object.entries(manifest?.devDependencies ?? {}))
            roots.set(name, { name, range });
    }
    for (const { name, range, saveType } of named) {
        roots.set(name, { name, range: range ?? 'latest', optional: saveType === 'optional', explicit: true });
    }
    return [...roots.values()];
}
/**
 * The project's manifest with what the command line named saved, as npm
 * saves it after an install: each package that installed (`installed`: the
 * version under its name) under its save type, at `^version` unless the
 * spec given is a range `^version` would widen, an alias as the package it
 * names; out of the fields its save type excludes; an optional one also
 * under dependencies (npm's affordance for older npms). One that did not
 * install keeps the spec given.
 */
export function saveNamed(manifest, named, installed) {
    const out = { ...manifest };
    const field = (type) => {
        const key = SAVE_FIELD[type];
        const current = out[key];
        const copy = { ...current };
        out[key] = copy;
        return copy;
    };
    const remove = (key, name) => {
        const current = out[key];
        if (current?.[name] === undefined)
            return;
        const { [name]: _gone, ...rest } = current;
        out[key] = rest;
    };
    for (const { name, range, saveType } of named) {
        if (saveType === 'prod') {
            remove('devDependencies', name);
            remove('peerDependencies', name);
        }
        else if (saveType === 'dev')
            remove('dependencies', name);
        else if (saveType === 'optional')
            remove('peerDependencies', name);
        else {
            remove('dependencies', name);
            remove('optionalDependencies', name);
        }
        const spec = range ?? '*';
        const version = installed(name);
        let saved = spec;
        if (version !== null) {
            // reify.js #saveIdealTree: a range the saved `^version` would widen is kept as given.
            const { range: requested, alias, registryName } = parseRegistryRequest(name, spec);
            const prefixed = `^${version}`;
            const isRange = isSemverRange(requested) && !isExactVersion(requested) && requested !== '*' && requested !== '' && requested !== 'latest';
            const range = isRange && !rangeSubset(prefixed, requested) ? requested : prefixed;
            saved = alias ? `npm:${registryName}@${range}` : range;
        }
        const target = field(saveType);
        if (saved !== '*' || target[name] === undefined)
            target[name] = saved;
        if (saveType === 'optional')
            field('prod')[name] = target[name];
    }
    return out;
}
/** The required failures of `plan`: any fails the install. */
export function requiredFailures(plan) {
    return plan.failures.filter(({ id }) => plan.required.has(id));
}
const localeCompare = (a, b) => a.localeCompare(b, 'en');
/** npm's order for a layer: by the dependent's depth, its path, then the name. */
function npmOrder(a, b) {
    return depthOf(a.from) - depthOf(b.from) || localeCompare(a.from, b.from) || localeCompare(a.name, b.name);
}
/** Plan the tree `roots` need, from what `host` answers. */
export async function planTree(roots, host, options = {}) {
    const rootEdges = roots.map(({ name, range, optional, explicit }) => ({
        name, range, from: '', kind: 'dep', optional: optional === true, explicit: explicit === true,
    }));
    const nodes = new Map();
    // Installed packages read so far that no edge has met yet.
    const candidates = new Map();
    const probed = new Set();
    // Every edge of the tree (the project's, and each node's), by the name it asks for.
    const dependents = new Map();
    const index = (edges) => {
        for (const edge of edges) {
            const list = dependents.get(edge.name) ?? [];
            dependents.set(edge.name, list);
            list.push(edge);
        }
    };
    const unindex = (from) => {
        for (const [name, list] of dependents)
            dependents.set(name, list.filter((edge) => edge.from !== from));
    };
    index(rootEdges);
    const failures = new Map();
    // Who asked for each failed request (its graph's edges in), and which edges failed.
    const failedAskers = new Map();
    const failedEdges = new Set();
    const omitted = new Set();
    const whenOptional = new Map();
    // Resolutions by request, for the life of the plan.
    const resolutions = new Map();
    const rootNames = new Set(roots.map(({ name }) => name));
    const requestKey = (edge) => `${edge.name}\0${edge.range}`;
    const fail = (edge, reason, refused) => {
        const id = `!${requestKey(edge)}`;
        if (!failures.has(id))
            failures.set(id, { edge, reason, refused, id });
        const askers = failedAskers.get(id) ?? [];
        failedAskers.set(id, askers);
        askers.push({ from: edge.from, to: id, optional: edge.optional });
        failedEdges.add(`${edge.from}\0${edge.name}`);
    };
    // The package Node's walk finds for `name` from inside `from`, placed or installed.
    const nearest = (from, name) => {
        for (const at of visiblePlacements(from, name)) {
            const node = nodes.get(at);
            if (node)
                return { at, pkg: node.pkg, kept: true };
            const candidate = candidates.get(at);
            if (candidate)
                return { at, pkg: candidate, kept: false };
        }
        return null;
    };
    // The tree's edges for `name` that Node's walk answers from `at`.
    const reliersOn = (at, name) => (dependents.get(name) ?? []).filter((edge) => nearest(edge.from, name)?.at === at);
    /** Keep the installed copy at `at`: it is part of the tree now, and its edges are walked. */
    const keep = (at, onward) => {
        const candidate = candidates.get(at);
        if (!candidate)
            return;
        candidates.delete(at);
        nodes.set(at, { at, planned: false, pkg: candidate });
        const edges = manifestEdges(candidate, at);
        index(edges);
        onward(edges);
    };
    /** Whether `pkg` may go into `target`'s node_modules for `edge` (can-place-dep). */
    const canPlace = (edge, pkg, target, deepest) => {
        const at = nestedPlacement(target, pkg.name);
        const current = nodes.get(at)?.pkg ?? candidates.get(at);
        if (current) {
            // checkCanPlaceCurrent.
            if (current.version === pkg.version && meets(current.version, edge))
                return edge.explicit ? { kind: 'place', at } : { kind: 'keep', at };
            if (versionAtLeast(pkg.version, current.version) && reliersOn(at, pkg.name).every((e) => meets(pkg.version, e)))
                return { kind: 'place', at };
            if (meets(current.version, edge) && !edge.explicit)
                return { kind: 'keep', at };
            return target === deepest && edge.kind !== 'peer' ? { kind: 'place', at } : { kind: 'conflict' };
        }
        // checkCanPlaceNoCurrent: the target's own edge for the name must take
        // it, and what Node's walk from the target finds now must not be
        // shadowed from anything beneath that relies on it and the new copy
        // would not meet.
        const targetNode = target === '' ? null : nodes.get(target);
        const own = target === edge.from ? undefined
            : (target === '' ? rootEdges : targetNode ? manifestEdges(targetNode.pkg, target) : []).find((e) => e.name === pkg.name);
        if (own && !meets(pkg.version, own))
            return { kind: 'conflict' };
        const visible = target === edge.from ? null : nearest(target, pkg.name);
        if (visible && reliersOn(visible.at, pkg.name).some((e) => within(e.from, target) && meets(visible.pkg.version, e) && !meets(pkg.version, e))) {
            return { kind: 'conflict' };
        }
        return { kind: 'place', at };
    };
    /** Where `pkg` goes for `edge`, as PlaceDep walks: from the deepest target up, the highest before a conflict. */
    const placeFor = (edge, pkg) => {
        const deepest = edge.kind === 'peer' ? parentPlacement(edge.from) : edge.from;
        let found = { kind: 'conflict' };
        for (let target = deepest;; target = parentPlacement(target)) {
            const verdict = canPlace(edge, pkg, target, deepest);
            if (verdict.kind === 'conflict')
                break;
            found = verdict;
            if (verdict.kind === 'keep' || target === '')
                break;
            // npm's shallow strategy: nothing above a top-level package's own node_modules.
            if (options.shallow && parentPlacement(target) === '')
                break;
        }
        return found;
    };
    // A required root of the project's own: its peers conflicting with the project's own dependency are npm's ERESOLVE.
    const requiredRoots = new Set(rootEdges.filter(({ optional }) => !optional).map(({ name }) => name));
    /**
     * Settle `queue`'s edges: each met as it is, or resolved and placed. Edges
     * of what is placed or kept go to `next`, but required peers, which go to
     * `peers`: a package's peers are placed with it, before the next layer
     * (npm's peer set).
     */
    const settle = async (queue, next, peers) => {
        const onward = (edges) => {
            for (const edge of edges)
                (edge.kind === 'peer' ? peers : next).push(edge);
        };
        queue.sort(npmOrder);
        // What is installed where these edges look, read once.
        const unprobed = [...new Set(queue.flatMap((edge) => visiblePlacements(edge.from, edge.name)))]
            .filter((at) => !probed.has(at) && !nodes.has(at));
        for (const at of unprobed)
            probed.add(at);
        if (unprobed.length > 0) {
            const found = await host.installed(unprobed);
            unprobed.forEach((at, i) => {
                const pkg = found[i];
                if (pkg)
                    candidates.set(at, pkg);
            });
        }
        // Edges met as they are, and what is left to resolve: each request once.
        const toPlace = [];
        for (const edge of queue) {
            const seen = edge.explicit ? null : nearest(edge.from, edge.name);
            if (seen && meets(seen.pkg.version, edge)) {
                keep(seen.at, onward);
                continue;
            }
            toPlace.push(edge);
        }
        const requests = [...new Map(toPlace.filter((edge) => !resolutions.has(requestKey(edge))).map((edge) => [requestKey(edge), edge])).values()];
        if (requests.length > 0) {
            const answers = await host.resolve(requests.map(({ name, range, optional }) => ({ name, range, optional })));
            requests.forEach((edge, i) => resolutions.set(requestKey(edge), answers[i] ?? { failed: 'the resolver returned no answer' }));
        }
        for (const edge of toPlace) {
            // An edge before it may have placed what meets it.
            const seen = edge.explicit ? null : nearest(edge.from, edge.name);
            if (seen?.kept && meets(seen.pkg.version, edge))
                continue;
            const answer = resolutions.get(requestKey(edge)) ?? { failed: 'the resolver returned no answer' };
            if ('failed' in answer) {
                fail(edge, answer.failed, false);
                continue;
            }
            if ('refused' in answer) {
                fail(edge, answer.refused, true);
                continue;
            }
            if ('omitted' in answer) {
                omitted.add(requestKey(edge));
                continue;
            }
            const { package: pkg } = answer;
            let place;
            if (edge.kind === 'peer' && seen?.kept) {
                // A peer met by a copy at another version: the copy its range
                // resolves to replaces that one where everything relying on it takes
                // it too (build-ideal-tree's #loadPeerSet). Otherwise the conflict is
                // npm's ERESOLVE when it is the project's own (a required root's
                // peer against what the project depends on), and else its warning.
                if (reliersOn(seen.at, edge.name).every((e) => meets(pkg.version, e))) {
                    place = { kind: 'place', at: seen.at };
                }
                else {
                    const mine = parentPlacement(edge.from) === '' && requiredRoots.has(edge.from) && seen.at === edge.name && rootNames.has(edge.name);
                    if (mine && !options.allowPeerConflicts) {
                        fail(edge, `ERESOLVE: ${edge.from} needs peer ${edge.name}@${edge.range}, and the project depends on ${edge.name}@${seen.pkg.version}`, false);
                    }
                    else {
                        await host.peerMismatch?.(edge, seen.at, seen.pkg.version);
                    }
                    continue;
                }
            }
            else {
                place = placeFor(edge, pkg);
            }
            if (place.kind === 'conflict') {
                if (edge.kind === 'peer' && seen)
                    await host.peerMismatch?.(edge, seen.at, seen.pkg.version);
                else
                    fail(edge, `${edge.name}@${edge.range} from ${edge.from || 'the project'} has no place: every copy it would replace or shadow is needed`, false);
                continue;
            }
            if (place.kind === 'keep') {
                keep(place.at, onward);
                continue;
            }
            if (depthOf(place.at) > MAX_NEST_DEPTH) {
                fail(edge, `${edge.name}@${edge.range} from ${edge.from} would nest deeper than ${MAX_NEST_DEPTH} levels (cycle with incompatible ranges)`, false);
                continue;
            }
            if (nodes.has(place.at))
                unindex(place.at);
            candidates.delete(place.at);
            probed.add(place.at);
            nodes.set(place.at, { at: place.at, planned: true, pkg, edge });
            if (answer.skipIfOptional !== undefined)
                whenOptional.set(place.at, answer.skipIfOptional);
            const edges = manifestEdges(pkg, place.at);
            index(edges);
            onward(edges);
        }
    };
    for (let queue = [...rootEdges]; queue.length > 0;) {
        const next = [];
        for (let peers = queue; peers.length > 0;) {
            const pending = peers;
            peers = [];
            await settle(pending, next, peers);
        }
        queue = next;
    }
    // ── The tree's graph: each edge into the copy Node's walk finds ──
    const edgesIn = new Map();
    const edgesOut = new Map();
    const link = (graphEdge) => {
        const into = edgesIn.get(graphEdge.to) ?? [];
        edgesIn.set(graphEdge.to, into);
        into.push(graphEdge);
        const out = edgesOut.get(graphEdge.from) ?? [];
        edgesOut.set(graphEdge.from, out);
        out.push(graphEdge);
    };
    const linkEdges = (from, edges) => {
        for (const edge of edges) {
            if (failedEdges.has(`${from}\0${edge.name}`) || omitted.has(requestKey(edge)))
                continue;
            const to = visiblePlacements(from, edge.name).find((at) => nodes.has(at));
            if (to !== undefined)
                link({ from, to, optional: edge.optional });
        }
    };
    // Only what the project reaches is the tree: a copy a replacement left
    // unreferenced goes, and an installed one is extraneous.
    linkEdges('', rootEdges);
    const reached = new Set();
    const pending = (edgesOut.get('') ?? []).map(({ to }) => to);
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
        if (reached.has(at))
            continue;
        reached.add(at);
        const node = nodes.get(at);
        if (!node)
            continue;
        linkEdges(at, manifestEdges(node.pkg, at));
        for (const { to } of edgesOut.get(at) ?? [])
            if (!reached.has(to))
                pending.push(to);
    }
    const extraneous = new Set(candidates.keys());
    for (const [at, node] of [...nodes]) {
        if (reached.has(at))
            continue;
        nodes.delete(at);
        if (!node.planned)
            extraneous.add(at);
    }
    for (const askers of failedAskers.values())
        for (const asker of askers)
            if (asker.from === '' || nodes.has(asker.from))
                link(asker);
    for (const id of [...failures.keys()])
        if (!edgesIn.has(id))
            failures.delete(id);
    // Required: reached by a path of required edges (calc-dep-flags).
    const required = new Set();
    const unflagged = (edgesOut.get('') ?? []).filter(({ optional }) => !optional).map(({ to }) => to);
    for (let at = unflagged.pop(); at !== undefined; at = unflagged.pop()) {
        if (required.has(at))
            continue;
        required.add(at);
        for (const { to, optional } of edgesOut.get(at) ?? [])
            if (!optional && !required.has(to))
                unflagged.push(to);
    }
    // optional-set.js: from `id` up its required edges in, to the
    // optionalDependencies edges into the set; then gather-dep-set.js: with
    // what the set needs that nothing outside it needs.
    const optionalSet = (id) => {
        const set = new Set([id]);
        for (const member of set)
            for (const { from, optional } of edgesIn.get(member) ?? [])
                if (!optional && from !== '')
                    set.add(from);
        const deps = new Set(set);
        for (const member of deps)
            for (const { to, optional } of edgesOut.get(member) ?? [])
                if (!optional)
                    deps.add(to);
        for (let changed = true; changed && deps.size > 0;) {
            changed = false;
            for (const dep of deps) {
                if (set.has(dep) || !(edgesIn.get(dep) ?? []).some(({ from, optional }) => !optional && !deps.has(from)))
                    continue;
                deps.delete(dep);
                changed = true;
            }
        }
        return deps;
    };
    const skipped = new Set();
    const reasons = new Map();
    const leaveOut = (id, reason) => {
        if (required.has(id))
            return null;
        reasons.set(id, reason);
        for (const member of optionalSet(id))
            skipped.add(member);
        return skipped;
    };
    for (const failure of failures.values())
        leaveOut(failure.id, failure.reason);
    for (const [at, reason] of whenOptional)
        if (nodes.has(at))
            leaveOut(at, reason);
    return {
        nodes,
        failures: [...failures.values()],
        required,
        skipped,
        reasons,
        extraneous,
        fail: leaveOut,
    };
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
