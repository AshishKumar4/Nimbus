/**
 * place-dep.ts — placing a package for an edge (place-dep.js): from the
 * deepest place it may go up toward the root, at the highest place where
 * neither it nor its peers conflict, its peers with it. A copy there is
 * kept, or replaced (what only the replaced copy needed goes with it); a
 * peer conflict the project owns is ERESOLVE unless forced, another's a
 * warning.
 */

import { MAX_NEST_DEPTH, type TreeEdge, type TreePackage } from '../npm-tree.js';
import { CanPlace } from './can-place.js';
import { localeCompare, Node, type Edge, type EdgeDefinition, type HostPackages, type Payload, type Tree } from './model.js';
import { deepestNestingTarget, gatherDepSet, peerEntrySets } from './sets.js';

/** One placement and what it entails (PlaceDep). */
export interface Placement<H extends HostPackages> {
  readonly edge: Edge<H>;
  /** The package placed, in its virtual root. */
  readonly dep: Node<H>;
  readonly parent: Placement<H> | null;
  /** Where it would start: above every dependent that has it as a peer. */
  readonly start: Node<H>;
  readonly explicit: boolean;
  canPlace: CanPlace<H> | null;
  canPlaceSelf: CanPlace<H> | null;
  placed: Node<H> | null;
  readonly children: Placement<H>[];
  /** Nodes whose edges a pruned peer set left unmet. */
  readonly needEvaluation: Set<Node<H>>;
}

/** A peer conflict the project owns: npm's ERESOLVE. */
export class PeerConflict extends Error {
  constructor(readonly edge: TreeEdge, message: string) { super(message); }
}

const topOf = <H extends HostPackages>(placement: Placement<H>): Placement<H> => (placement.parent ? topOf(placement.parent) : placement);

/** The copy of candidate `dep` that goes in the tree for `edge`. */
function placedCopy<H extends HostPackages>(dep: Node<H>, edge: Edge<H>): Payload<H> {
  const placedFor = edge.public;
  const { payload } = dep;
  if (payload.kind === 'candidate') return { kind: 'placed', pkg: payload.pkg, refused: payload.refused, skipIfOptional: payload.skipIfOptional, placedFor };
  if (payload.kind === 'failed') return { kind: 'failed', reason: payload.reason, placedFor };
  throw new Error(`only a package resolved for an edge is placed, not ${payload.kind}`);
}

export class Placer<H extends HostPackages> {
  readonly warnings: string[] = [];

  constructor(
    private readonly tree: Tree<H>,
    private readonly options: { readonly force?: boolean; readonly global?: boolean; readonly preferDedupe?: boolean },
    private readonly edgesOf: (pkg: TreePackage | null) => EdgeDefinition[],
  ) {}

  /** Place `dep` for `edge`, and its peers with it. */
  place(edge: Edge<H>, dep: Node<H>, parent: Placement<H> | null, explicit: boolean): Placement<H> {
    const placement: Placement<H> = {
      edge, dep, parent, explicit,
      start: deepestNestingTarget(parent ? parent.start : edge.from, edge.name),
      canPlace: null, canPlaceSelf: null, placed: null, children: [], needEvaluation: new Set(),
    };
    if (edge.to && edge.valid && !explicit) return placement;
    for (let target: Node<H> | null = placement.start; target; target = target.parent) {
      const targetEdge = target.edgesOut.get(edge.name);
      if (!target.isTop && targetEdge && targetEdge.peer) continue;
      const check = new CanPlace(dep, target, edge, parent?.canPlace ?? null, [], this.options.preferDedupe === true, explicit);
      if (check.self !== 'CONFLICT') placement.canPlaceSelf = check;
      if (check.verdict === 'CONFLICT') break;
      placement.canPlace = check;
      if (dep.failed !== undefined) break;
      // A global prefix's shallow strategy: nothing goes above a top-level package.
      if (this.options.global && target.parent?.isProjectRoot) break;
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
      if (edge.peer && !edge.valid) this.warnPeerConflict(edge, dep);
      this.pruneDedupable(target, true);
      return placement;
    }

    // A copy of the package goes in the tree; past the nesting cap (a cycle
    // of incompatible ranges, which npm breaks with a link), a failure instead.
    const placed = target.depth + 1 > MAX_NEST_DEPTH && dep.failed === undefined
      ? new Node<H>(dep.name, {
        kind: 'failed', placedFor: edge.public,
        reason: `${dep.name}@${dep.version ?? edge.spec} from ${edge.from.location || 'the project'} would nest deeper than ${MAX_NEST_DEPTH} levels (cycle with incompatible ranges)`,
      }, [])
      : new Node<H>(dep.name, placedCopy(dep, edge), this.edgesOf(dep.pkg));
    placement.placed = placed;
    const old = target.children.get(edge.name);
    if (old) this.replaceOld(placement, placed, old);
    else this.tree.attach(placed, target);
    if (edge.peer && !placed.satisfies(edge)) this.warnPeerConflict(edge, dep);
    if (edge.valid && edge.to && edge.to !== placed) this.pruneDedupable(edge.to, false);
    for (const node of [...this.tree.named(edge.name)]) {
      if (node.tree !== this.tree || !node.isDescendantOf(target) || node.isTop) continue;
      this.pruneDedupable(node, false);
      if (node.tree === this.tree) for (const kid of [...node.children.values()]) this.pruneDedupable(kid, false);
    }
    // Its peers go with it, where they go.
    const members = dep.parent?.children;
    for (const peerEdge of [...placed.edgesOut.values()]) {
      if (peerEdge.valid || !peerEdge.peer || peerEdge.peerConflicted) continue;
      const peer = members?.get(peerEdge.name);
      if (!peer || !peer.satisfies(peerEdge)) continue;
      placement.children.push(this.place(peerEdge, peer, placement, explicit));
    }
    return placement;
  }

  /** Replace `old` with `placed` (replaceOldDep): what only the old one needed goes, and peer sets it no longer meets are looked at again. */
  private replaceOld(placement: Placement<H>, placed: Node<H>, old: Node<H>): void {
    const target = old.parent;
    if (!target) return;
    const oldDeps: Node<H>[] = [];
    for (const [name, edge] of old.edgesOut) {
      const to = edge.to;
      if (!placed.edgesOut.has(name) && to) oldDeps.push(...gatherDepSet([to], (e) => e.to !== to));
    }
    const prunePeerSets: Node<H>[] = [];
    for (const edge of [...old.edgesIn]) {
      if (placed.satisfies(edge) || !edge.peer || edge.from.parent !== target || edge.peerConflicted) continue;
      for (const entry of peerEntrySets(edge.from).keys()) {
        const entryNode = entry.to;
        if (!entryNode) continue;
        // As npm reckons it: the entry node's own place (deepestNestingTarget with no name).
        if (deepestNestingTarget(entryNode, undefined) !== target && !entry.from.isProjectRoot) {
          prunePeerSets.push(...gatherDepSet([entryNode], (e) => e.to !== entryNode && !e.peerConflicted));
        } else {
          this.warnPeerConflict(edge, placement.dep);
        }
      }
    }
    this.tree.replace(placed, old);
    this.pruneForReplacement(placed, oldDeps);
    for (const dep of prunePeerSets) {
      for (const into of dep.edgesIn) placement.needEvaluation.add(into.from);
      this.tree.detach(dep);
    }
  }

  private pruneForReplacement(node: Node<H>, oldDeps: readonly Node<H>[]): void {
    const invalid = new Set<Node<H>>();
    for (const edge of node.edgesOut.values()) if (edge.to && !edge.valid) invalid.add(edge.to);
    for (const dep of oldDeps) for (const each of gatherDepSet([dep], (e) => e.to !== dep && e.valid)) invalid.add(each);
    for (const dep of gatherDepSet(invalid, (e) => e.from !== node && e.to !== node && e.valid)) this.tree.detach(dep);
  }

  private pruneDedupable(node: Node<H>, descend: boolean): void {
    if (node.tree !== this.tree) return;
    if (node.canDedupe(this.options.preferDedupe === true)) {
      for (const dep of gatherDepSet([node], (e) => e.to !== node && e.valid)) this.tree.detach(dep);
      return;
    }
    if (!descend) return;
    for (const child of [...node.children.values()].sort((a, b) => localeCompare(a.location, b.location))) this.pruneDedupable(child, true);
  }

  /** Whether the conflict at `edge` is the project's own (PlaceDep.isMine). */
  private isMine(edge: Edge<H>): boolean {
    const node = edge.from;
    if (node.isProjectRoot) return true;
    if (!edge.peer) return false;
    let peerEdges = false;
    for (const into of node.edgesIn) {
      if (into.peer) {
        peerEdges = true;
        continue;
      }
      if (into.from.isProjectRoot) return true;
    }
    if (peerEdges) for (const entry of peerEntrySets(node).keys()) if (entry.from.isProjectRoot) return true;
    return false;
  }

  warnPeerConflict(edge: Edge<H>, dep: Node<H>): void {
    edge.peerConflicted = true;
    const current = edge.from.resolve(edge.name);
    this.warnings.push(`ERESOLVE overriding peer dependency: ${edge.from.location || 'the project'} wants ${edge.name}@${edge.spec}` +
      `${current?.version ? `, the tree has ${current.name}@${current.version}` : ''}${dep.version ? `, found ${dep.name}@${dep.version}` : ''}`);
  }
}
