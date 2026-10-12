/**
 * build.ts — the ideal tree's build (build-ideal-tree.js #buildDeps): a
 * queue of nodes, the shallowest first, each visited once while it is in the
 * tree. A node's problem edges (unmet, invalid, or named on the command
 * line) are each resolved into a virtual root (a copy of the dependent,
 * outside the tree) with the package's peer set, and placed (place-dep.ts);
 * what a placement leaves unmet is queued again.
 */
import { bundledNames, edgeRequest, isPeer, manifestEdges } from '../npm-tree.js';
import { localeCompare, Node, Tree } from './model.js';
import { Placer, PeerConflict } from './place-dep.js';
export class Builder {
    tree;
    host;
    options;
    /** Nodes that failed to load: their edges are no problem to solve. */
    loadFailures = new Set();
    placer;
    resolutions = new Map();
    /** Whether a placement changed the tree (#mutateTree). */
    mutated = false;
    queue = [];
    queued = new Set();
    queueSorted = true;
    /** Requests whose package's edges prefetch has asked for. */
    expanded = new Set();
    seen = new Set();
    virtualRoots = new Map();
    /** A package's edges, read from its manifest once. */
    edgeDefinitions = new WeakMap();
    constructor(tree, host, options) {
        this.tree = tree;
        this.host = host;
        this.options = options;
        this.placer = new Placer(tree, options, (pkg) => this.edgesOf(pkg));
    }
    edgesOf(pkg) {
        if (pkg === null)
            return [];
        let edges = this.edgeDefinitions.get(pkg);
        if (edges === undefined) {
            edges = manifestEdges(pkg, { legacyPeerDeps: this.options.legacyPeerDeps === true });
            this.edgeDefinitions.set(pkg, edges);
        }
        return edges;
    }
    // ── The queue (DepsQueue): the shallowest first, then by placement ──
    push(node) {
        if (this.queued.has(node))
            return;
        this.queued.add(node);
        this.queueSorted = false;
        this.queue.push(node);
    }
    pop() {
        if (!this.queueSorted) {
            // Each node's place read once for the sort.
            const keyed = this.queue.map((node) => ({ node, depth: node.depth, location: node.location }));
            keyed.sort((a, b) => a.depth - b.depth || localeCompare(a.location, b.location));
            this.queue = keyed.map(({ node }) => node);
            this.queueSorted = true;
        }
        const node = this.queue.shift();
        if (node)
            this.queued.delete(node);
        return node;
    }
    // ── Resolution ──
    requestKey(name, range) { return `${name}\0${range}`; }
    /**
     * Resolve every request not yet answered, together. One no registry
     * answers (a git, file, directory or URL spec) fails here, without asking:
     * npm installs it from where it points, which this engine does not.
     */
    async resolve(requests) {
        const missing = [];
        for (const request of requests) {
            const key = this.requestKey(request.name, request.range);
            if (this.resolutions.has(key))
                continue;
            if (edgeRequest(request.name, request.range).registry) {
                missing.push(request);
                this.resolutions.set(key, { failed: 'the resolver returned no answer' });
            }
            else {
                this.resolutions.set(key, { failed: `${request.name}@${request.range} is not a registry package (a git, file, directory or URL spec), which is not supported here` });
            }
        }
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
            ? new Node(name, { kind: 'failed', reason: answer.failed }, [])
            : new Node(name, { kind: 'candidate', pkg: answer.package, refused: answer.refused, skipIfOptional: answer.skipIfOptional }, this.edgesOf(answer.package));
        if (node.failed !== undefined)
            this.loadFailures.add(node);
        parent.tree?.attach(node, parent);
        return node;
    }
    /** A root outside the tree with `source`'s edges, where a package and its peer set are loaded (#virtualRoot). */
    virtualRoot(source, reuse) {
        const existing = reuse ? this.virtualRoots.get(source) : undefined;
        if (existing)
            return existing;
        const root = new Node('', { kind: 'virtual-root', source }, [...source.edgesOut.values()].map((edge) => edge.definition));
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
        // A global top-level package's peers are not loaded with it: they would
        // become top-level packages of their own. The next pass meets them.
        if (this.options.global && edge.from.isProjectRoot)
            return node;
        return this.loadPeerSet(node, required);
    }
    /** Load `node`'s peers, and theirs, into its virtual root (#loadPeerSet). */
    async loadPeerSet(node, required) {
        const root = node.parent;
        if (!root || root.payload.kind !== 'virtual-root')
            return node;
        const source = root.payload.source;
        const peerEdges = [...node.edgesOut.values()].filter((edge) => edge.peer && !(edge.valid && edge.to)).sort((a, b) => localeCompare(a.name, b.name));
        for (const edge of peerEdges) {
            if (edge.valid && edge.to)
                continue;
            const parentEdge = root.edgesOut.get(edge.name);
            const conflictOK = this.options.force === true || !source.isProjectRoot;
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
                throw new PeerConflict(edge.public, `ERESOLVE unable to resolve dependency tree: ${node.name}@${node.version ?? '?'} needs peer ${edge.name}@${edge.spec}, and ${source.location || 'the project'} depends on ${edge.name}@${dep.version ?? parentEdge.spec}`);
            }
            // There is one already, which this peer does not accept: one that it
            // does accept replaces it, where everything relying on it accepts it.
            const current = edge.to;
            const dep = await this.nodeFromEdge(edge, null, null, required);
            if (dep.canReplace(current)) {
                await this.nodeFromEdge(edge, root, null, required);
                continue;
            }
            if (conflictOK || !required.has(edge.from))
                continue;
            throw new PeerConflict(edge.public, `ERESOLVE unable to resolve dependency tree: ${node.name}@${node.version ?? '?'} needs peer ${edge.name}@${edge.spec}, which conflicts with ${current.name}@${current.version ?? '?'}`);
        }
        return node;
    }
    /** A node's problem edges: unmet (but an optional peer's), invalid, or named on the command line (#problemEdges); what its archive bundles is its own. */
    problemEdges(node) {
        const problems = [];
        const pkg = node.isProjectRoot ? null : node.pkg;
        const bundled = new Set(pkg === null ? [] : bundledNames(pkg));
        for (const edge of node.edgesOut.values()) {
            if (bundled.has(edge.name))
                continue;
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
    /**
     * What the coming visits will ask, resolved ahead, a level at a time: the
     * queue's problem edges, then every edge of what they resolve to (a peer
     * also at its source's own spec, which its peer set prefers), and so on
     * down. Resolution is the host's round trip; this keeps the trips to the
     * depth of the tree, not its width. A request is expanded once.
     */
    async prefetch(node) {
        let frontier = [node, ...this.queue].flatMap((member) => (member.tree === this.tree ? this.problemEdges(member) : []))
            .map((edge) => ({ name: edge.name, range: edge.spec, from: edge.from }));
        while (frontier.length > 0) {
            await this.resolve(frontier);
            const next = [];
            for (const { name, range, from } of frontier) {
                const key = this.requestKey(name, range);
                if (this.expanded.has(key))
                    continue;
                this.expanded.add(key);
                const answer = this.resolutions.get(key);
                if (!answer || 'failed' in answer)
                    continue;
                for (const edge of this.edgesOf(answer.package)) {
                    if (edge.type === 'peerOptional' && !this.tree.mentions(edge.name))
                        continue;
                    const peer = isPeer(edge.type);
                    next.push({ name: edge.name, range: edge.range, from: peer ? from : null });
                    const own = peer ? from?.edgesOut.get(edge.name) : undefined;
                    if (own)
                        next.push({ name: edge.name, range: own.spec, from });
                }
            }
            frontier = next.filter(({ name, range }) => !this.expanded.has(this.requestKey(name, range)));
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
            if (problems.some((edge) => !this.resolutions.has(this.requestKey(edge.name, edge.spec))))
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
                this.visit(this.placer.place(edge, dep, null, edge.explicit));
        }
    }
    visit(placement) {
        const { placed, edge, canPlace } = placement;
        if (placed && canPlace) {
            this.mutated = true;
            if (placed.failed !== undefined)
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
}
