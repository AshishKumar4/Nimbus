/**
 * flags.ts — what the project reaches, and through which edges
 * (calc-dep-flags.js): every edge from the project, its required (not
 * optional) edges, and its prod (not dev) edges. A folder holding a node is
 * kept with it (resetParents), but only edges are followed.
 */

import type { Edge, HostPackages, Node } from './model.js';

export interface DepFlags<H extends HostPackages> {
  /** Reached by some path: what is not is extraneous. */
  readonly reached: ReadonlySet<Node<H>>;
  /** Reached by a path of required edges: its failure fails the install. */
  readonly required: ReadonlySet<Node<H>>;
  /** Reached by a path that starts at no devDependency: what is not is dev. */
  readonly prod: ReadonlySet<Node<H>>;
}

export function calcDepFlags<H extends HostPackages>(project: Node<H>): DepFlags<H> {
  const reached = new Set<Node<H>>();
  const required = new Set<Node<H>>();
  const prod = new Set<Node<H>>();
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
  }
  for (const flagged of [reached, required, prod]) {
    for (const each of [...flagged]) for (let up = each.parent; up && !up.isProjectRoot; up = up.parent) flagged.add(up);
  }
  return { reached, required, prod };
}
