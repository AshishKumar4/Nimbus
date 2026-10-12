/**
 * place-dep.ts — placing a package for an edge (place-dep.js): from the
 * deepest place it may go up toward the root, at the highest place where
 * neither it nor its peers conflict, its peers with it. A copy there is
 * kept, or replaced (what only the replaced copy needed goes with it); a
 * peer conflict the project owns is ERESOLVE unless forced, another's a
 * warning.
 */
import { type TreeEdge, type TreePackage } from '../npm-tree.js';
import { CanPlace } from './can-place.js';
import { Node, type Edge, type EdgeDefinition, type HostPackages, type Tree } from './model.js';
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
export declare class PeerConflict extends Error {
    readonly edge: TreeEdge;
    constructor(edge: TreeEdge, message: string);
}
export declare class Placer<H extends HostPackages> {
    private readonly tree;
    private readonly options;
    private readonly edgesOf;
    readonly warnings: string[];
    constructor(tree: Tree<H>, options: {
        readonly force?: boolean;
        readonly global?: boolean;
        readonly preferDedupe?: boolean;
        readonly strictPeerDeps?: boolean;
    }, edgesOf: (pkg: TreePackage | null) => EdgeDefinition[]);
    /** Place `dep` for `edge`, and its peers with it. */
    place(edge: Edge<H>, dep: Node<H>, parent: Placement<H> | null, explicit: boolean): Placement<H>;
    /** Replace `old` with `placed` (replaceOldDep): what only the old one needed goes, and peer sets it no longer meets are looked at again. */
    private replaceOld;
    private pruneForReplacement;
    private pruneDedupable;
    /** Whether the conflict at `edge` is the project's own (PlaceDep.isMine). */
    private isMine;
    warnPeerConflict(edge: Edge<H>, dep: Node<H>): void;
}
//# sourceMappingURL=place-dep.d.ts.map