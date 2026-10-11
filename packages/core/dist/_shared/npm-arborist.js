/**
 * npm-arborist.ts — npm's one install engine: the ideal tree an install
 * reifies, built as npm 10.9.8's arborist builds it (build-ideal-tree.js,
 * place-dep.js, can-place-dep.js, calc-dep-flags.js, optional-set.js,
 * gather-dep-set.js, peer-entry-sets.js, deepest-nesting-target.js), over
 * the tree a host says is installed and from what it resolves. Both hosts
 * install through it (worker npm/installer.ts, lifo commands/system/npm.ts).
 *
 * The tree is nodes in node_modules folders and the edges between them; an
 * edge goes to the copy Node's walk finds from its dependent. The build
 * visits nodes, not edges: a queue of nodes, the shallowest first, each
 * visited once while it is in the tree. A node's problem edges (unmet,
 * invalid, or named on the command line) are each resolved into a virtual
 * root (a copy of the dependent, outside the tree) with the package's peer
 * set, and placed as PlaceDep places them: from the deepest place it may go
 * up toward the root, at the highest place where neither it nor any of its
 * peers conflicts, the peers with it. A copy there may be kept, replaced
 * (what only the replaced copy needed goes with it), or left in conflict:
 * a peer conflict the project owns is npm's ERESOLVE unless forced, and
 * another's a warning.
 *
 * Then calc-dep-flags marks what the project reaches: what it does not is
 * extraneous, and goes; what only optional edges reach is optional, and
 * what only devDependencies reach is dev. A package that failed to load,
 * or that the host refuses (EBADPLATFORM), fails the install where it is
 * required and is left out with its optional set where it is optional.
 *
 * A frozen plan (npm ci) builds nothing: the tree is the one the lock
 * records, given as installed; only its flags and failures are found.
 */
import { versionAtLeast } from './npm-semver.js';
import { depthOf, edgeRequest, isOptional, isPeer, manifestEdges, MAX_NEST_DEPTH, meets, } from './npm-tree.js';
/** The required failures of `plan`: any fails the install. */
export function requiredFailures(plan) {
    return plan.failures.filter(({ id }) => plan.required.has(id));
}
// ── The tree's model ─────────────────────────────────────────────────────────
/** npm's string order (@isaacs/string-locale-compare's 'en'), one collator for every comparison. */
const localeCompare = new Intl.Collator('en').compare;
class Edge {
    from;
    name;
    spec;
    type;
    explicit;
    /** The node Node's walk finds from `from`, kept current by its tree. */
    to = null;
    peerConflicted = false;
    constructor(from, name, spec, type, explicit) {
        this.from = from;
        this.name = name;
        this.spec = spec;
        this.type = type;
        this.explicit = explicit;
    }
    get peer() { return isPeer(this.type); }
    get optional() { return isOptional(this.type); }
    /** Edge.valid: met, or an absent optional peer; never a peer inside its own dependent. */
    get valid() {
        if (this.to === null)
            return this.type === 'peerOptional';
        if (this.peer && this.to.parent === this.from && !this.from.isTop)
            return false;
        return this.to.satisfies(this);
    }
    get definition() { return { name: this.name, range: this.spec, type: this.type, explicit: this.explicit }; }
    get public() { return { name: this.name, range: this.spec, from: this.from.location, type: this.type, explicit: this.explicit }; }
}
class Node {
    name;
    pkg;
    origin;
    marks;
    children = new Map();
    edgesOut = new Map();
    edgesIn = new Set();
    parent = null;
    /** The tree it is in; null once taken out. */
    tree = null;
    constructor(name, 
    /** Null for one that failed to load. */
    pkg, origin, marks, edges) {
        this.name = name;
        this.pkg = pkg;
        this.origin = origin;
        this.marks = marks;
        for (const { name: dep, range, type, explicit } of edges)
            this.edgesOut.set(dep, new Edge(this, dep, range, type, explicit === true));
    }
    get isProjectRoot() { return this.origin === 'project'; }
    get isTop() { return this.parent === null; }
    /** A top-level package of a global prefix. */
    get globalTop() { return this.tree?.global === true && this.parent?.isProjectRoot === true; }
    get version() { return this.pkg?.version ?? null; }
    get location() {
        if (this.parent === null)
            return '';
        const parent = this.parent.location;
        return parent ? `${parent}/node_modules/${this.name}` : this.name;
    }
    get depth() {
        let depth = 0;
        for (let up = this.parent; up; up = up.parent)
            depth++;
        return depth;
    }
    *ancestry() { for (let node = this; node; node = node.parent)
        yield node; }
    isDescendantOf(ancestor) {
        for (const node of this.ancestry())
            if (node === ancestor)
                return true;
        return false;
    }
    resolve(name) {
        for (const node of this.ancestry()) {
            const child = node.children.get(name);
            if (child)
                return child;
        }
        return null;
    }
    satisfies(edge) {
        if (this.pkg === null || edge.name !== this.name)
            return false;
        const { registryName } = edgeRequest(edge.name, edge.spec);
        if (this.pkg.registryName !== undefined && this.pkg.registryName !== registryName)
            return false;
        return meets(this.pkg.version, { name: edge.name, range: edge.spec });
    }
    /** The same package at the same version. */
    matches(other) {
        if (this.pkg === null || other.pkg === null || this.name !== other.name || this.pkg.version !== other.pkg.version)
            return false;
        return this.pkg.registryName === undefined || other.pkg.registryName === undefined || this.pkg.registryName === other.pkg.registryName;
    }
}
/** One tree of nodes (the ideal tree, or a virtual root's), every edge's target kept current as nodes come and go. */
class Tree {
    root;
    global;
    edgesByName = new Map();
    byName = new Map();
    constructor(root, global) {
        this.root = root;
        this.global = global;
        this.register(root);
    }
    named(name) { return this.byName.get(name) ?? new Set(); }
    /** Whether anything in the tree is, or asks for, `name`. */
    mentions(name) { return (this.byName.get(name)?.size ?? 0) > 0 || (this.edgesByName.get(name)?.size ?? 0) > 0; }
    *nodes() {
        const pending = [...this.root.children.values()];
        for (let node = pending.pop(); node; node = pending.pop()) {
            yield node;
            pending.push(...node.children.values());
        }
    }
    /** Put `node` in `parent`'s node_modules, where what was there goes. */
    attach(node, parent) {
        if (node.parent === parent && parent.children.get(node.name) === node)
            return;
        const old = parent.children.get(node.name);
        if (old)
            this.detach(old);
        if (node.parent)
            this.detach(node);
        node.parent = parent;
        parent.children.set(node.name, node);
        for (const each of [node, ...descendants(node)])
            this.register(each);
        this.reload(node.name, parent);
    }
    /** Put `node` where `old` is: it takes what `old` holds (Node.replace). */
    replace(node, old) {
        const parent = old.parent;
        if (parent === null)
            return;
        for (const kid of old.children.values()) {
            kid.parent = node;
            node.children.set(kid.name, kid);
        }
        old.children.clear();
        this.unregister(old);
        old.parent = null;
        node.parent = parent;
        parent.children.set(node.name, node);
        this.register(node);
        this.reload(node.name, parent);
    }
    /** Take `node`, and what is beneath it, out of the tree. */
    detach(node) {
        const parent = node.parent;
        if (parent === null || node.tree !== this)
            return;
        parent.children.delete(node.name);
        node.parent = null;
        for (const each of [node, ...descendants(node)])
            this.unregister(each);
        this.reload(node.name, parent);
    }
    register(node) {
        node.tree = this;
        if (node !== this.root) {
            let named = this.byName.get(node.name);
            if (!named)
                this.byName.set(node.name, named = new Set());
            named.add(node);
        }
        for (const edge of node.edgesOut.values()) {
            let edges = this.edgesByName.get(edge.name);
            if (!edges)
                this.edgesByName.set(edge.name, edges = new Set());
            edges.add(edge);
            this.retarget(edge);
        }
    }
    unregister(node) {
        node.tree = null;
        this.byName.get(node.name)?.delete(node);
        for (const edge of node.edgesOut.values()) {
            this.edgesByName.get(edge.name)?.delete(edge);
            edge.to?.edgesIn.delete(edge);
            edge.to = null;
        }
    }
    /** Every edge for `name` from `parent` or beneath it, retargeted. */
    reload(name, parent) {
        for (const edge of [...this.edgesByName.get(name) ?? []])
            if (edge.from.isDescendantOf(parent))
                this.retarget(edge);
    }
    retarget(edge) {
        const to = edge.from.resolve(edge.name);
        if (to === edge.to)
            return;
        edge.to?.edgesIn.delete(edge);
        edge.to = to;
        to?.edgesIn.add(edge);
    }
}
function* descendants(node) {
    const pending = [...node.children.values()];
    for (let each = pending.pop(); each; each = pending.pop()) {
        yield each;
        pending.push(...each.children.values());
    }
}
// ── Sets of nodes (gather-dep-set.js, optional-set.js, peer-entry-sets.js) ──
/** `set` with everything it depends on (through `follow`), less what anything outside the result depends on. */
function gatherDepSet(set, follow) {
    const deps = new Set(set);
    for (const node of deps)
        for (const edge of node.edgesOut.values())
            if (edge.to && follow(edge))
                deps.add(edge.to);
    for (let changed = true; changed && deps.size > 0;) {
        changed = false;
        for (const dep of deps) {
            for (const edge of dep.edgesIn) {
                if (!deps.has(edge.from) && follow(edge)) {
                    changed = true;
                    deps.delete(dep);
                    break;
                }
            }
        }
    }
    return deps;
}
/** What goes with an optional `node` that fails: up to the optional edges into it, and what only that needs. */
function optionalSet(node) {
    const set = new Set([node]);
    for (const member of set)
        for (const edge of member.edgesIn)
            if (!edge.optional)
                set.add(edge.from);
    return gatherDepSet(set, (edge) => !edge.optional);
}
/** The peer groups `node` is in, by the edge that enters each. */
function peerEntrySets(node) {
    const union = new Set([node]);
    for (const member of union) {
        for (const edge of member.edgesOut.values())
            if (edge.valid && edge.peer && edge.to)
                union.add(edge.to);
        for (const edge of member.edgesIn)
            if (edge.valid && edge.peer)
                union.add(edge.from);
    }
    const sets = new Map();
    for (const peer of union) {
        for (const edge of peer.edgesIn) {
            if (!edge.valid || (edge.peer && !edge.from.isTop))
                continue;
            const sub = new Set([peer]);
            for (const member of sub)
                for (const out of member.edgesOut.values())
                    if (out.valid && out.peer && out.to)
                        sub.add(out.to);
            if (sub.has(node))
                sets.set(edge, sub);
        }
    }
    return sets;
}
/** The deepest place `name`, a dependency of `start`, may go: above every dependent that has it as a peer. */
function deepestNestingTarget(start, name) {
    for (const target of start.ancestry()) {
        if (target.isProjectRoot || target.parent === null || target.globalTop)
            return target;
        const edge = name === undefined ? undefined : target.edgesOut.get(name);
        if (!edge || !edge.peer)
            return target;
    }
    return start;
}
/** Whether `node` may stand in for `old`: every edge into `old` from outside what only `old` needs accepts it (Node.canReplaceWith). */
function canReplace(node, old, ignorePeers = []) {
    if (node.name !== old.name)
        return false;
    if (node.pkg?.registryName !== undefined && old.pkg?.registryName !== undefined && node.pkg.registryName !== old.pkg.registryName)
        return false;
    const ignored = new Set(ignorePeers);
    const depSet = gatherDepSet([old], (edge) => edge.to !== old && edge.valid);
    for (const edge of old.edgesIn) {
        if (!old.isTop && edge.from.parent === old.parent && edge.peer && ignored.has(edge.from.name))
            continue;
        if (!depSet.has(edge.from) && !node.satisfies(edge))
            return false;
    }
    return true;
}
/** Whether `node` is a needless copy: nothing wants it, or a copy two folders up does as well (Node.canDedupe). */
function canDedupe(node, preferDedupe) {
    const grandparent = node.parent?.parent;
    if (!grandparent)
        return false;
    if (node.edgesIn.size === 0)
        return true;
    const other = grandparent.resolve(node.name);
    if (!other)
        return false;
    if (other.matches(node))
        return true;
    if (!canReplace(other, node))
        return false;
    return preferDedupe || (other.version !== null && node.version !== null && versionAtLeast(other.version, node.version));
}
/** Whether `dep` (a member of its virtual root's peer set) may go into `target`'s node_modules for `edge`, with its peers (CanPlaceDep). Reads the tree; never changes it. */
class CanPlace {
    dep;
    target;
    edge;
    parent;
    peerPath;
    explicit;
    verdict;
    self = null;
    children = [];
    current;
    targetEdge;
    edgeOverride;
    preferDedupe;
    peersChecked = null;
    constructor(dep, target, edge, parent, peerPath, preferDedupe, explicit) {
        this.dep = dep;
        this.target = target;
        this.edge = edge;
        this.parent = parent;
        this.peerPath = peerPath;
        this.explicit = explicit;
        this.preferDedupe = preferDedupe || edge.peer;
        this.current = target.children.get(edge.name);
        this.targetEdge = target.edgesOut.get(edge.name);
        this.edgeOverride = !dep.satisfies(edge);
        this.verdict = this.check();
        if (this.self === null)
            this.self = this.verdict;
    }
    get top() { return this.parent ? this.parent.top : this; }
    get deepest() { return deepestNestingTarget(this.parent ? this.parent.deepest : this.edge.from, this.edge.name); }
    check() {
        const { target, targetEdge, current, dep, edge } = this;
        // A package that failed to load goes in the first place tried: the install fails, or it is pruned.
        if (dep.marks.failed !== undefined)
            return current ? 'REPLACE' : 'OK';
        if (targetEdge && targetEdge.peer && !target.isTop)
            return 'CONFLICT';
        if (!current && targetEdge && !dep.satisfies(targetEdge) && targetEdge !== edge)
            return 'CONFLICT';
        return current ? this.checkCurrent(current) : this.checkNoCurrent();
    }
    checkCurrent(current) {
        const { dep, edge, explicit, target, preferDedupe } = this;
        if (dep.matches(current) && (current.satisfies(edge) || this.edgeOverride))
            return explicit ? 'REPLACE' : 'KEEP';
        const tryReplace = current.version !== null && dep.version !== null && versionAtLeast(dep.version, current.version);
        if (tryReplace && canReplace(dep, current)) {
            const peers = this.peers('REPLACE');
            if (peers !== 'CONFLICT')
                return peers;
        }
        if (current.satisfies(edge) && (!explicit || preferDedupe))
            return 'KEEP';
        if (preferDedupe && !tryReplace && canReplace(dep, current)) {
            const peers = this.peers('REPLACE');
            if (peers !== 'CONFLICT')
                return peers;
        }
        if (target !== this.deepest)
            return 'CONFLICT';
        if (!edge.peer && target === edge.from)
            return this.peers('REPLACE');
        if (!this.parent && !edge.peer)
            return 'CONFLICT';
        // Each peer group the current copy is in must be replaceable by this
        // set, or able to nest deeper than here.
        const members = dep.parent?.children ?? new Map();
        let replaceable = true;
        for (const [entryEdge, currentPeers] of peerEntrySets(current)) {
            if (entryEdge === edge || entryEdge === this.top.edge)
                continue;
            const entryNode = entryEdge.to;
            if (!entryNode)
                continue;
            const entryRep = members.get(entryNode.name);
            if (entryRep && canReplace(entryRep, entryNode, members.keys()))
                continue;
            let clobber = !entryRep;
            if (!entryRep) {
                const walk = new Set([entryNode]);
                outer: for (const peer of walk) {
                    for (const out of peer.edgesOut.values()) {
                        if (!out.peer || !out.valid)
                            continue;
                        const rep = members.get(out.name);
                        if (!rep) {
                            if (out.to)
                                walk.add(out.to);
                            continue;
                        }
                        if (!rep.satisfies(out)) {
                            clobber = false;
                            break outer;
                        }
                    }
                }
            }
            if (clobber)
                continue;
            for (const currentPeer of currentPeers) {
                const curDeep = deepestNestingTarget(entryEdge.from, currentPeer.name);
                if (curDeep === target || target.isDescendantOf(curDeep)) {
                    replaceable = false;
                    break;
                }
            }
        }
        return replaceable ? this.peers('REPLACE') : 'CONFLICT';
    }
    checkNoCurrent() {
        const { target, dep, edge } = this;
        const current = target !== this.top.edge.from ? target.resolve(edge.name) : null;
        if (current) {
            for (const into of current.edgesIn) {
                if (into.from.isDescendantOf(target) && into.valid && !dep.satisfies(into))
                    return 'CONFLICT';
            }
        }
        return this.peers('OK');
    }
    /** Whether the peers of `dep` can go with it: `state`, or CONFLICT. */
    peers(state) {
        this.self = state;
        if (this.peersChecked !== null)
            return this.peersChecked;
        const peerPath = [...this.peerPath, this.dep];
        let conflict = false;
        for (const peerEdge of this.dep.edgesOut.values()) {
            const peer = peerEdge.to;
            if (!peerEdge.peer || !peer || peerPath.includes(peer))
                continue;
            const check = new CanPlace(peer, deepestNestingTarget(this.target, peer.name), peerEdge, this, peerPath, true, false);
            this.children.push(check);
            if (check.verdict === 'CONFLICT')
                conflict = true;
        }
        this.peersChecked = conflict ? 'CONFLICT' : state;
        return this.peersChecked;
    }
}
const topOf = (placement) => (placement.parent ? topOf(placement.parent) : placement);
class PeerConflict extends Error {
    edge;
    constructor(edge, message) {
        super(message);
        this.edge = edge;
    }
}
// ── The build (build-ideal-tree.js) ──────────────────────────────────────────
class Builder {
    tree;
    host;
    options;
    loadFailures = new Set();
    warnings = [];
    queue = [];
    queueSorted = true;
    seen = new Set();
    virtualRoots = new Map();
    resolutions = new Map();
    constructor(tree, host, options) {
        this.tree = tree;
        this.host = host;
        this.options = options;
    }
    edgesOf(pkg) {
        return pkg === null ? [] : manifestEdges(pkg, { legacyPeerDeps: this.options.legacyPeerDeps === true });
    }
    // ── The queue (DepsQueue): the shallowest first, then by placement ──
    push(node) {
        if (this.queue.includes(node))
            return;
        this.queueSorted = false;
        this.queue.push(node);
    }
    pop() {
        if (!this.queueSorted) {
            this.queue.sort((a, b) => a.depth - b.depth || localeCompare(a.location, b.location));
            this.queueSorted = true;
        }
        return this.queue.shift();
    }
    // ── Resolution ──
    requestKey(name, range) { return `${name}\0${range}`; }
    /** Resolve every request not yet answered, together. */
    async resolve(requests) {
        const missing = [...new Map(requests.filter(({ name, range }) => !this.resolutions.has(this.requestKey(name, range)))
                .map((request) => [this.requestKey(request.name, request.range), request])).values()];
        if (missing.length === 0)
            return;
        const answers = await this.host.resolve(missing);
        missing.forEach(({ name, range }, i) => this.resolutions.set(this.requestKey(name, range), answers[i] ?? { failed: 'the resolver returned no answer' }));
    }
    /** The node `name@spec` resolves to, in `parent` (a virtual root): its package, or a load failure (#nodeFromSpec). */
    async nodeFromSpec(name, spec, parent) {
        await this.resolve([{ name, range: spec }]);
        const answer = this.resolutions.get(this.requestKey(name, spec)) ?? { failed: 'the resolver returned no answer' };
        const node = 'failed' in answer
            ? new Node(name, null, 'virtual', { failed: answer.failed }, [])
            : new Node(name, answer.package, 'virtual', { refused: answer.refused, skipIfOptional: answer.skipIfOptional }, this.edgesOf(answer.package));
        if (node.marks.failed !== undefined)
            this.loadFailures.add(node);
        parent.tree?.attach(node, parent);
        return node;
    }
    /** A root outside the tree with `source`'s edges, where a package and its peer set are loaded (#virtualRoot). */
    virtualRoot(source, reuse) {
        const existing = reuse ? this.virtualRoots.get(source) : undefined;
        if (existing)
            return existing;
        const root = new Node('', source.pkg, 'virtual', { sourceReference: source }, [...source.edgesOut.values()].map((edge) => edge.definition));
        new Tree(root, false);
        this.virtualRoots.set(source, root);
        return root;
    }
    /** The package for `edge`, loaded with its peer set into a virtual root (#nodeFromEdge). */
    async nodeFromEdge(edge, parent, secondEdge, required) {
        const root = parent ?? this.virtualRoot(edge.from, false);
        const first = await this.nodeFromSpec(edge.name, edge.spec, root);
        // A second spec, where the first does not meet it: taken when it meets the first edge too.
        const second = secondEdge && !secondEdge.valid ? await this.nodeFromSpec(edge.name, secondEdge.spec, root) : null;
        const node = second && edge.valid ? second : first;
        root.tree?.attach(node, root);
        if ((required.has(edge.from) && edge.type !== 'peerOptional') || (secondEdge && required.has(secondEdge.from) && secondEdge.type !== 'peerOptional'))
            required.add(node);
        // A global top-level package's peers are not placed with it.
        if (this.options.shallow && edge.from.isProjectRoot)
            return node;
        return this.loadPeerSet(node, required);
    }
    /** Load `node`'s peers, and theirs, into its virtual root (#loadPeerSet). */
    async loadPeerSet(node, required) {
        const root = node.parent;
        if (!root)
            return node;
        const peerEdges = [...node.edgesOut.values()].filter((edge) => edge.peer && !(edge.valid && edge.to)).sort((a, b) => localeCompare(a.name, b.name));
        for (const edge of peerEdges) {
            if (edge.valid && edge.to)
                continue;
            const parentEdge = root.edgesOut.get(edge.name);
            const conflictOK = this.options.force === true || root.marks.sourceReference?.isProjectRoot !== true;
            if (!edge.to) {
                if (!parentEdge) {
                    // An optional peer is never placed for its package: it only
                    // constrains what the tree has or asks for. Where nothing in the
                    // tree mentions the name it cannot conflict, and is not resolved.
                    if (edge.type === 'peerOptional' && !this.tree.mentions(edge.name))
                        continue;
                    await this.nodeFromEdge(edge, root, null, required);
                    continue;
                }
                // The dependent's own spec, steered by this one.
                const dep = await this.nodeFromEdge(parentEdge, root, edge, required);
                if (edge.valid)
                    continue;
                if (conflictOK || !required.has(dep)) {
                    edge.peerConflicted = true;
                    continue;
                }
                throw new PeerConflict(edge.public, `ERESOLVE unable to resolve dependency tree: ${node.name}@${node.version ?? '?'} needs peer ${edge.name}@${edge.spec}, and ${root.marks.sourceReference?.location || 'the project'} depends on ${edge.name}@${dep.version ?? parentEdge.spec}`);
            }
            // There is one already, which this peer does not accept: one that it
            // does accept replaces it, where everything relying on it accepts it.
            const current = edge.to;
            const dep = await this.nodeFromEdge(edge, null, null, required);
            if (canReplace(dep, current)) {
                await this.nodeFromEdge(edge, root, null, required);
                continue;
            }
            if (conflictOK || !required.has(edge.from))
                continue;
            throw new PeerConflict(edge.public, `ERESOLVE unable to resolve dependency tree: ${node.name}@${node.version ?? '?'} needs peer ${edge.name}@${edge.spec}, which conflicts with ${current.name}@${current.version ?? '?'}`);
        }
        return node;
    }
    /** A node's problem edges: unmet (but an optional peer's), invalid, or named on the command line (#problemEdges). */
    problemEdges(node) {
        const problems = [];
        for (const edge of node.edgesOut.values()) {
            if (edge.to && this.loadFailures.has(edge.to))
                continue;
            if (!edge.to) {
                if (edge.type !== 'peerOptional' || edge.explicit)
                    problems.push(edge);
                continue;
            }
            if (!edge.valid || edge.explicit)
                problems.push(edge);
        }
        return problems;
    }
    /** What the coming visits will ask, resolved together: the queue's problem edges, then their packages' peers, a set at a time. */
    async prefetch(node) {
        const edges = [node, ...this.queue].flatMap((member) => (member.tree === this.tree ? this.problemEdges(member) : []));
        let requests = edges.map((edge) => ({ name: edge.name, range: edge.spec, from: edge.from }));
        for (const seen = new Set(); requests.length > 0;) {
            await this.resolve(requests);
            const next = [];
            for (const { name, range, from } of requests) {
                const key = this.requestKey(name, range);
                if (seen.has(key))
                    continue;
                seen.add(key);
                const answer = this.resolutions.get(key);
                if (!answer || 'failed' in answer)
                    continue;
                for (const peer of this.edgesOf(answer.package)) {
                    if (!isPeer(peer.type) || (peer.type === 'peerOptional' && !this.tree.mentions(peer.name)))
                        continue;
                    next.push({ name: peer.name, range: peer.range, from });
                    const own = from.edgesOut.get(peer.name);
                    if (own)
                        next.push({ name: peer.name, range: own.spec, from });
                }
            }
            requests = next;
        }
    }
    async build() {
        // What is installed with an edge it does not meet is visited too.
        const walked = new Set();
        for (const pending = [this.tree.root]; pending.length > 0;) {
            const each = pending.pop();
            if (!each || walked.has(each))
                continue;
            walked.add(each);
            if (each === this.tree.root || [...each.edgesOut.values()].some((edge) => !edge.valid))
                this.push(each);
            for (const edge of each.edgesOut.values())
                if (edge.to)
                    pending.push(edge.to);
        }
        for (let node = this.pop(); node; node = this.pop()) {
            if (this.seen.has(node) || node.tree !== this.tree)
                continue;
            this.seen.add(node);
            const problems = this.problemEdges(node);
            if (problems.length === 0)
                continue;
            await this.prefetch(node);
            const tasks = [];
            for (const edge of problems) {
                if (edge.peerConflicted)
                    continue;
                const root = this.virtualRoot(node, true);
                const rootEdge = root.edgesOut.get(edge.name);
                const rootDep = rootEdge?.valid ? rootEdge.to : null;
                const required = new Set([edge.from]);
                const dep = rootDep && rootDep.satisfies(edge) ? rootDep : await this.nodeFromEdge(edge, edge.peer ? root : null, null, required);
                tasks.push({ edge, dep });
            }
            tasks.sort((a, b) => localeCompare(a.edge.name, b.edge.name));
            for (const { edge, dep } of tasks)
                this.visit(this.place(edge, dep, null, edge.explicit));
        }
    }
    visit(placement) {
        const { placed, edge, canPlace } = placement;
        if (placed && canPlace) {
            if (placed.marks.failed !== undefined)
                this.loadFailures.add(placed);
            for (const into of [...placed.edgesIn]) {
                if (into === edge || into.valid || into.peerConflicted)
                    continue;
                if (canPlace.self === 'REPLACE') {
                    this.seen.delete(into.from);
                    this.push(into.from);
                }
                else if (!this.seen.has(into.from)) {
                    this.push(into.from);
                }
            }
            this.push(placed);
            for (const dep of placement.needEvaluation) {
                this.seen.delete(dep);
                this.push(dep);
            }
        }
        for (const child of placement.children)
            this.visit(child);
    }
    // ── PlaceDep ──
    /** Place `dep` for `edge`, and its peers with it. */
    place(edge, dep, parent, explicit) {
        const placement = {
            edge, dep, parent, explicit,
            start: deepestNestingTarget(parent ? parent.start : edge.from, edge.name),
            canPlace: null, canPlaceSelf: null, placed: null, children: [], needEvaluation: new Set(),
        };
        if (edge.to && edge.valid && !explicit)
            return placement;
        for (const target of placement.start.ancestry()) {
            const targetEdge = target.edgesOut.get(edge.name);
            if (!target.isTop && targetEdge && targetEdge.peer)
                continue;
            const check = new CanPlace(dep, target, edge, parent?.canPlace ?? null, [], false, explicit);
            if (check.self !== 'CONFLICT')
                placement.canPlaceSelf = check;
            if (check.verdict === 'CONFLICT')
                break;
            placement.canPlace = check;
            if (dep.marks.failed !== undefined)
                break;
            if (this.options.shallow && target.parent?.isProjectRoot)
                break;
        }
        if (!placement.canPlace) {
            const top = topOf(placement);
            if (!this.options.force && this.isMine(top.edge)) {
                const current = top.edge.from.resolve(top.edge.name);
                throw new PeerConflict(top.edge.public, `ERESOLVE could not resolve: ${top.dep.name}@${top.dep.version ?? top.edge.spec} for ${top.edge.from.location || 'the project'}${current?.version ? `, which has ${current.name}@${current.version}` : ''}`);
            }
            if (!placement.canPlaceSelf) {
                this.warnPeerConflict(edge, dep);
                return placement;
            }
            placement.canPlace = placement.canPlaceSelf;
        }
        const { target } = placement.canPlace;
        if (placement.canPlace.verdict === 'KEEP') {
            if (edge.peer && !edge.valid)
                this.warnPeerConflict(edge, dep);
            this.pruneDedupable(target, true);
            return placement;
        }
        // A copy of the package goes in the tree; past the nesting cap (a cycle
        // of incompatible ranges), a failure instead.
        const nests = target.depth + 1 > MAX_NEST_DEPTH && dep.marks.failed === undefined;
        const placed = nests
            ? new Node(dep.name, null, 'planned', { failed: `${dep.name}@${dep.version ?? edge.spec} from ${edge.from.location || 'the project'} would nest deeper than ${MAX_NEST_DEPTH} levels (cycle with incompatible ranges)`, placedFor: edge.public }, [])
            : new Node(dep.name, dep.pkg, 'planned', { ...dep.marks, placedFor: edge.public }, this.edgesOf(dep.pkg));
        placement.placed = placed;
        const old = target.children.get(edge.name);
        if (old)
            this.replaceOld(placement, placed, old);
        else
            this.tree.attach(placed, target);
        if (edge.peer && !placed.satisfies(edge))
            this.warnPeerConflict(edge, dep);
        if (edge.valid && edge.to && edge.to !== placed)
            this.pruneDedupable(edge.to, false);
        for (const node of [...this.tree.named(edge.name)]) {
            if (node.tree !== this.tree || !node.isDescendantOf(target) || node.isTop)
                continue;
            this.pruneDedupable(node, false);
            if (node.tree === this.tree)
                for (const kid of [...node.children.values()])
                    this.pruneDedupable(kid, false);
        }
        // Its peers go with it, where they go.
        const members = dep.parent?.children;
        for (const peerEdge of [...placed.edgesOut.values()]) {
            if (peerEdge.valid || !peerEdge.peer || peerEdge.peerConflicted)
                continue;
            const peer = members?.get(peerEdge.name);
            if (!peer || !peer.satisfies(peerEdge))
                continue;
            placement.children.push(this.place(peerEdge, peer, placement, explicit));
        }
        return placement;
    }
    /** Replace `old` with `placed` (replaceOldDep): what only the old one needed goes, and peer sets it no longer meets are looked at again. */
    replaceOld(placement, placed, old) {
        const target = old.parent;
        if (!target)
            return;
        const oldDeps = [];
        for (const [name, edge] of old.edgesOut) {
            const to = edge.to;
            if (!placed.edgesOut.has(name) && to)
                oldDeps.push(...gatherDepSet([to], (e) => e.to !== to));
        }
        const prunePeerSets = [];
        for (const edge of [...old.edgesIn]) {
            if (placed.satisfies(edge) || !edge.peer || edge.from.parent !== target || edge.peerConflicted)
                continue;
            for (const entry of peerEntrySets(edge.from).keys()) {
                const entryNode = entry.to;
                if (!entryNode)
                    continue;
                // As npm reckons it: the entry node's own place (deepestNestingTarget with no name).
                if (deepestNestingTarget(entryNode, undefined) !== target && !entry.from.isProjectRoot) {
                    prunePeerSets.push(...gatherDepSet([entryNode], (e) => e.to !== entryNode && !e.peerConflicted));
                }
                else {
                    this.warnPeerConflict(edge, placement.dep);
                }
            }
        }
        this.tree.replace(placed, old);
        this.pruneForReplacement(placed, oldDeps);
        for (const dep of prunePeerSets) {
            for (const into of dep.edgesIn)
                placement.needEvaluation.add(into.from);
            this.tree.detach(dep);
        }
    }
    pruneForReplacement(node, oldDeps) {
        const invalid = new Set();
        for (const edge of node.edgesOut.values())
            if (edge.to && !edge.valid)
                invalid.add(edge.to);
        for (const dep of oldDeps)
            for (const each of gatherDepSet([dep], (e) => e.to !== dep && e.valid))
                invalid.add(each);
        for (const dep of gatherDepSet(invalid, (e) => e.from !== node && e.to !== node && e.valid))
            this.tree.detach(dep);
    }
    pruneDedupable(node, descend) {
        if (node.tree !== this.tree)
            return;
        if (canDedupe(node, false)) {
            for (const dep of gatherDepSet([node], (e) => e.to !== node && e.valid))
                this.tree.detach(dep);
            return;
        }
        if (!descend)
            return;
        for (const child of [...node.children.values()].sort((a, b) => localeCompare(a.location, b.location)))
            this.pruneDedupable(child, true);
    }
    /** Whether the conflict at `edge` is the project's own (PlaceDep.isMine). */
    isMine(edge) {
        const node = edge.from;
        if (node.isProjectRoot)
            return true;
        if (!edge.peer)
            return false;
        let peerEdges = false;
        for (const into of node.edgesIn) {
            if (into.peer) {
                peerEdges = true;
                continue;
            }
            if (into.from.isProjectRoot)
                return true;
        }
        if (peerEdges)
            for (const entry of peerEntrySets(node).keys())
                if (entry.from.isProjectRoot)
                    return true;
        return false;
    }
    warnPeerConflict(edge, dep) {
        edge.peerConflicted = true;
        const current = edge.from.resolve(edge.name);
        this.warnings.push(`ERESOLVE overriding peer dependency: ${edge.from.location || 'the project'} wants ${edge.name}@${edge.spec}` +
            `${current?.version ? `, the tree has ${current.name}@${current.version}` : ''}${dep.version ? `, found ${dep.name}@${dep.version}` : ''}`);
    }
}
// ── The plan ─────────────────────────────────────────────────────────────────
/** Plan the tree `roots` need over what is `installed`, from what `host` answers. */
export async function planTree(roots, installed, host, options = {}) {
    const project = new Node('', null, 'project', {}, roots.map(({ name, range, type, explicit }) => ({ name, range, type, explicit })));
    const tree = new Tree(project, options.shallow === true);
    const builder = new Builder(tree, host, options);
    // The installed tree, each package in its folder.
    const installedAt = new Map([['', project]]);
    for (const entry of [...installed].sort((a, b) => depthOf(a.at) - depthOf(b.at))) {
        const slash = entry.at.lastIndexOf('/node_modules/');
        const parent = installedAt.get(slash < 0 ? '' : entry.at.slice(0, slash));
        if (!parent)
            continue;
        const name = slash < 0 ? entry.at : entry.at.slice(slash + '/node_modules/'.length);
        const node = 'failed' in entry
            ? new Node(name, null, 'installed', { failed: entry.failed }, [])
            : new Node(name, entry.pkg, 'installed', { refused: entry.refused, skipIfOptional: entry.skipIfOptional }, builder.edgesOf(entry.pkg));
        tree.attach(node, parent);
        installedAt.set(entry.at, node);
        if (node.marks.failed !== undefined)
            builder.loadFailures.add(node);
    }
    const failures = new Map();
    if (!options.frozen) {
        try {
            await builder.build();
        }
        catch (error) {
            if (!(error instanceof PeerConflict))
                throw error;
            failures.set('!ERESOLVE', { edge: error.edge, reason: error.message, refused: false, id: '!ERESOLVE' });
        }
    }
    for (const message of builder.warnings)
        await host.warn?.(message);
    // ── calc-dep-flags: what the project reaches, and through which edges ──
    // What the project's edges reach, and what its required edges reach: a
    // folder holding one is kept with it (calc-dep-flags' resetParents), but
    // only edges are followed.
    const reached = new Set();
    const required = new Set();
    const mark = (flagged, start, follow) => {
        const pending = [start];
        for (let each = pending.pop(); each; each = pending.pop()) {
            if (flagged.has(each))
                continue;
            flagged.add(each);
            for (const edge of each.edgesOut.values())
                if (edge.to && follow(edge))
                    pending.push(edge.to);
        }
    };
    for (const edge of project.edgesOut.values()) {
        if (!edge.to)
            continue;
        mark(reached, edge.to, () => true);
        if (!edge.optional)
            mark(required, edge.to, (e) => !e.optional);
    }
    const withFolders = (flagged) => {
        for (const each of [...flagged])
            for (let up = each.parent; up && !up.isProjectRoot; up = up.parent)
                flagged.add(up);
    };
    withFolders(reached);
    withFolders(required);
    // ── What the project does not reach is extraneous, and goes; a frozen tree is installed as it is ──
    if (!options.frozen)
        for (const each of [...tree.nodes()])
            if (each.tree === tree && !reached.has(each))
                tree.detach(each);
    const extraneous = new Set();
    for (const [at, each] of installedAt)
        if (at !== '' && each.tree !== tree)
            extraneous.add(at);
    // The tree, as the hosts get it, before anything is left out of it.
    const nodes = new Map();
    const requiredAt = new Set();
    for (const each of tree.nodes()) {
        const at = each.location;
        if (required.has(each))
            requiredAt.add(at);
        if (each.pkg === null)
            continue;
        // The host's own packages, under the types it gave them.
        nodes.set(at, each.origin === 'planned' && each.marks.placedFor
            ? { at, planned: true, pkg: each.pkg, edge: each.marks.placedFor }
            : { at, planned: false, pkg: each.pkg });
    }
    // ── A package that failed to load, or is refused: a required one fails the install, an optional one goes with its optional set ──
    const skipped = new Set();
    const reasons = new Map();
    const leaveOut = (start, reason) => {
        if (required.has(start))
            return null;
        reasons.set(start.location, reason);
        const set = optionalSet(start);
        for (const member of set)
            skipped.add(member.location);
        for (const member of set)
            tree.detach(member);
        return skipped;
    };
    const failure = (each, reason, refused) => {
        const id = each.location;
        failures.set(id, {
            edge: each.marks.placedFor ?? { name: each.name, range: '*', from: each.parent?.location ?? '', type: 'prod', explicit: false },
            reason, refused, id,
        });
        if (required.has(each))
            requiredAt.add(id);
        else
            leaveOut(each, reason);
    };
    for (const each of [...builder.loadFailures])
        if (each.tree === tree && each.marks.failed !== undefined)
            failure(each, each.marks.failed, false);
    for (const each of [...tree.nodes()])
        if (each.tree === tree && each.marks.refused !== undefined)
            failure(each, each.marks.refused, true);
    for (const each of [...tree.nodes()])
        if (each.tree === tree && each.marks.skipIfOptional !== undefined && !required.has(each))
            leaveOut(each, each.marks.skipIfOptional);
    if (failures.has('!ERESOLVE'))
        requiredAt.add('!ERESOLVE');
    const byPlacement = new Map([...tree.nodes()].map((each) => [each.location, each]));
    return {
        nodes,
        failures: [...failures.values()],
        required: requiredAt,
        skipped,
        reasons,
        extraneous,
        fail: (at, reason) => {
            const each = byPlacement.get(at);
            if (!each || each.tree !== tree)
                return skipped.has(at) ? skipped : null;
            return leaveOut(each, reason);
        },
    };
}
