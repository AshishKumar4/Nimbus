/**
 * flags.ts — what the project reaches, and through which edges
 * (calc-dep-flags.js). A node is dev when no path to it starts at a prod
 * edge, optional when every path has an optional edge, devOptional when no
 * path is both, and peer when every path has a peer edge. A folder holding
 * a node is kept with it (resetParents), but only edges are followed.
 */
import type { HostPackages, Node } from './model.js';
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
export declare function calcDepFlags<H extends HostPackages>(project: Node<H>): DepFlags<H>;
//# sourceMappingURL=flags.d.ts.map