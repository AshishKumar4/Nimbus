/**
 * flags.ts — what the project reaches, and through which edges
 * (calc-dep-flags.js). A node is dev when no path to it starts at a prod
 * edge, optional when every path has an optional edge, devOptional when no
 * path is both, and peer when every path has a peer edge. A folder holding
 * a node is kept with it (resetParents), but only edges are followed.
 */

import type { Edge, HostPackages, Node } from './model.js';

export interface DepFlags<H extends HostPackages> {
  /** Reached by some path: what is not is extraneous. */
  readonly reached: ReadonlySet<Node<H>>;
  /** Reached by a path of required edges: its failure fails the install. */
  readonly required: ReadonlySet<Node<H>>;
  /** Reached by a path that starts at no devDependency: what is not is dev. */
  readonly prod: ReadonlySet<Node<H>>;
  /** Reached by a required path that starts at no devDependency: what is not is devOptional. */
  readonly prodRequired: ReadonlySet<Node<H>>;
  /** Reached by a path with no peer edge: what is not is peer. */
  readonly nonPeer: ReadonlySet<Node<H>>;
}

export function calcDepFlags<H extends HostPackages>(project: Node<H>): DepFlags<H> {
  const reached = new Set<Node<H>>();
  const required = new Set<Node<H>>();
  const prod = new Set<Node<H>>();
  const prodRequired = new Set<Node<H>>();
  const nonPeer = new Set<Node<H>>();
  const mark = (flagged: Set<Node<H>>, start: Node<H>, follow: (edge: Edge<H>) => boolean) => {
    const pending = [start];
    for (let each = pending.pop(); each; each = pending.pop()) {
      if (flagged.has(each)) continue;
      flagged.add(each);
      for (const edge of each.edgesOut.values()) if (edge.to && follow(edge)) pending.push(edge.to);
    }
  };
  for (const edge of project.edgesOut.values()) {
    if (!edge.to) continue;
    mark(reached, edge.to, () => true);
    if (!edge.optional) mark(required, edge.to, (e) => !e.optional);
    if (edge.type !== 'dev') mark(prod, edge.to, () => true);
    if (edge.type !== 'dev' && !edge.optional) mark(prodRequired, edge.to, (e) => !e.optional);
    if (!edge.peer) mark(nonPeer, edge.to, (e) => !e.peer);
  }
  for (const flagged of [reached, required, prod, prodRequired, nonPeer]) {
    for (const each of [...flagged]) for (let up = each.parent; up && !up.isProjectRoot; up = up.parent) flagged.add(up);
  }
  return { reached, required, prod, prodRequired, nonPeer };
}
