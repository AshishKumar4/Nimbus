/**
 * sets.ts — sets of nodes arborist reasons over (gather-dep-set.js,
 * optional-set.js, peer-entry-sets.js, deepest-nesting-target.js).
 */

import type { Edge, HostPackages, Node } from './model.js';

/** `set` with everything it depends on (through `follow`), less what anything outside the result depends on. */
export function gatherDepSet<H extends HostPackages>(set: Iterable<Node<H>>, follow: (edge: Edge<H>) => boolean): Set<Node<H>> {
  const deps = new Set(set);
  for (const node of deps) for (const edge of node.edgesOut.values()) if (edge.to && follow(edge)) deps.add(edge.to);
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
export function optionalSet<H extends HostPackages>(node: Node<H>): Set<Node<H>> {
  const set = new Set([node]);
  for (const member of set) for (const edge of member.edgesIn) if (!edge.optional) set.add(edge.from);
  return gatherDepSet(set, (edge) => !edge.optional);
}

/** The peer groups `node` is in, by the edge that enters each. */
export function peerEntrySets<H extends HostPackages>(node: Node<H>): Map<Edge<H>, Set<Node<H>>> {
  const union = new Set([node]);
  for (const member of union) {
    for (const edge of member.edgesOut.values()) if (edge.valid && edge.peer && edge.to) union.add(edge.to);
    for (const edge of member.edgesIn) if (edge.valid && edge.peer) union.add(edge.from);
  }
  const sets = new Map<Edge<H>, Set<Node<H>>>();
  for (const peer of union) {
    for (const edge of peer.edgesIn) {
      if (!edge.valid || (edge.peer && !edge.from.isTop)) continue;
      const sub = new Set([peer]);
      for (const member of sub) for (const out of member.edgesOut.values()) if (out.valid && out.peer && out.to) sub.add(out.to);
      if (sub.has(node)) sets.set(edge, sub);
    }
  }
  return sets;
}

/** The deepest place `name`, a dependency of `start`, may go: above every dependent that has it as a peer. */
export function deepestNestingTarget<H extends HostPackages>(start: Node<H>, name: string | undefined): Node<H> {
  for (let target: Node<H> | null = start; target; target = target.parent) {
    if (target.isProjectRoot || target.parent === null || target.globalTop) return target;
    const edge = name === undefined ? undefined : target.edgesOut.get(name);
    if (!edge || !edge.peer) return target;
  }
  return start;
}
