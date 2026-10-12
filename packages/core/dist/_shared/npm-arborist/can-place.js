/**
 * can-place.ts — whether a package may go into a folder for an edge, with
 * its peers (can-place-dep.js): OK, REPLACE what is there, KEEP what is
 * there, or CONFLICT. Reads the tree; never changes it.
 */
import { versionAtLeast } from '../npm-semver.js';
import { deepestNestingTarget, peerEntrySets } from './sets.js';
/** `dep` (a member of its virtual root's peer set) in `target`'s node_modules for `edge` (CanPlaceDep). */
export class CanPlace {
    dep;
    target;
    edge;
    parent;
    peerPath;
    explicit;
    verdict;
    /** Its own verdict, the peers aside (canPlaceSelf). */
    self = null;
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
        if (dep.failed !== undefined)
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
        if (tryReplace && dep.canReplace(current)) {
            const peers = this.peers('REPLACE');
            if (peers !== 'CONFLICT')
                return peers;
        }
        if (current.satisfies(edge) && (!explicit || preferDedupe))
            return 'KEEP';
        if (preferDedupe && !tryReplace && dep.canReplace(current)) {
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
            if (entryRep && entryRep.canReplace(entryNode, members.keys()))
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
            if (check.verdict === 'CONFLICT')
                conflict = true;
        }
        this.peersChecked = conflict ? 'CONFLICT' : state;
        return this.peersChecked;
    }
}
