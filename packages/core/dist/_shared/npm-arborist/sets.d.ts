/**
 * sets.ts — sets of nodes arborist reasons over (gather-dep-set.js,
 * optional-set.js, peer-entry-sets.js, deepest-nesting-target.js).
 */
import type { Edge, HostPackages, Node } from './model.js';
/** `set` with everything it depends on (through `follow`), less what anything outside the result depends on. */
export declare function gatherDepSet<H extends HostPackages>(set: Iterable<Node<H>>, follow: (edge: Edge<H>) => boolean): Set<Node<H>>;
/** What goes with an optional `node` that fails: up to the optional edges into it, and what only that needs. */
export declare function optionalSet<H extends HostPackages>(node: Node<H>): Set<Node<H>>;
/** The peer groups `node` is in, by the edge that enters each. */
export declare function peerEntrySets<H extends HostPackages>(node: Node<H>): Map<Edge<H>, Set<Node<H>>>;
/** The deepest place `name`, a dependency of `start`, may go: above every dependent that has it as a peer. */
export declare function deepestNestingTarget<H extends HostPackages>(start: Node<H>, name: string | undefined): Node<H>;
//# sourceMappingURL=sets.d.ts.map