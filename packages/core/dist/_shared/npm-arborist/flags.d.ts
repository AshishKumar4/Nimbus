/**
 * flags.ts — what the project reaches, and through which edges
 * (calc-dep-flags.js): every edge from the project, its required (not
 * optional) edges, and its prod (not dev) edges. A folder holding a node is
 * kept with it (resetParents), but only edges are followed.
 */
import type { HostPackages, Node } from './model.js';
export interface DepFlags<H extends HostPackages> {
    /** Reached by some path: what is not is extraneous. */
    readonly reached: ReadonlySet<Node<H>>;
    /** Reached by a path of required edges: its failure fails the install. */
    readonly required: ReadonlySet<Node<H>>;
    /** Reached by a path that starts at no devDependency: what is not is dev. */
    readonly prod: ReadonlySet<Node<H>>;
}
export declare function calcDepFlags<H extends HostPackages>(project: Node<H>): DepFlags<H>;
//# sourceMappingURL=flags.d.ts.map