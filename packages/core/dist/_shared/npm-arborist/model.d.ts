/**
 * model.ts — the tree npm's arborist builds (node.js, edge.js): nodes in
 * node_modules folders, the edges between them, and each edge's target, the
 * copy Node's walk finds from its dependent, kept current as nodes come and
 * go. A node carries what it is (Payload): the project, a virtual root, a
 * package installed before this install, a package resolved for it (a
 * candidate in a virtual root, or a copy placed in the tree), or one that
 * failed to load; a host's own package types are kept through it.
 */
import { type EdgeRequest, type EdgeType, type TreeEdge, type TreePackage } from '../npm-tree.js';
import type { HostVerdicts, LockFlags } from './plan.js';
/** npm's string order (@isaacs/string-locale-compare's 'en'), one collator for every comparison. */
export declare const localeCompare: (x: string, y: string) => number;
/** The package types a host gives the engine: what it resolves, and what it says is installed. */
export interface HostPackages {
    readonly resolved: TreePackage;
    readonly installed: TreePackage;
}
/** What a node is. */
export type Payload<H extends HostPackages> = {
    readonly kind: 'project';
}
/** A root outside the tree with `source`'s edges, where a package and its peers are loaded (#virtualRoot). */
 | {
    readonly kind: 'virtual-root';
    readonly source: Node<H>;
} | ({
    readonly kind: 'installed';
    readonly pkg: H['installed'];
    readonly lock?: LockFlags;
} & HostVerdicts)
/** Resolved for an edge, in a virtual root. */
 | ({
    readonly kind: 'candidate';
    readonly pkg: H['resolved'];
} & HostVerdicts)
/** Resolved and placed in the tree, for `placedFor`. */
 | ({
    readonly kind: 'placed';
    readonly pkg: H['resolved'];
    readonly placedFor: TreeEdge;
} & HostVerdicts)
/** No package: it could not be resolved, or nested. */
 | {
    readonly kind: 'failed';
    readonly reason: string;
    readonly placedFor?: TreeEdge;
};
/** An edge as a manifest declares it. */
export type EdgeDefinition = Pick<TreeEdge, 'name' | 'range' | 'type'> & {
    readonly explicit?: boolean;
};
export declare class Edge<H extends HostPackages> {
    readonly from: Node<H>;
    readonly name: string;
    readonly spec: string;
    readonly type: EdgeType;
    readonly explicit: boolean;
    /** The node Node's walk finds from `from`, kept current by its tree. */
    to: Node<H> | null;
    peerConflicted: boolean;
    /** What its spec asks for, read once. */
    readonly request: EdgeRequest;
    /** Which versions it accepts, by version: a tree asks one edge of one version many times. */
    private readonly accepted;
    constructor(from: Node<H>, name: string, spec: string, type: EdgeType, explicit: boolean);
    /** Whether a package at `version` meets it (dep-valid: an alias by its target's range, whatever package fills it); none meets a spec no registry answers. */
    accepts(version: string): boolean;
    get peer(): boolean;
    get optional(): boolean;
    /** Edge.error is null: met, or optional and absent; never a peer inside its own dependent (PEER LOCAL), but a top's. */
    get valid(): boolean;
    get definition(): EdgeDefinition;
    get public(): TreeEdge;
}
export declare class Node<H extends HostPackages> {
    readonly name: string;
    readonly payload: Payload<H>;
    readonly children: Map<string, Node<H>>;
    readonly edgesOut: Map<string, Edge<H>>;
    readonly edgesIn: Set<Edge<H>>;
    parent: Node<H> | null;
    /** The tree it is in; null once taken out. */
    tree: Tree<H> | null;
    constructor(name: string, payload: Payload<H>, edges: readonly EdgeDefinition[]);
    /** Its package; null for the project and one that failed. */
    get pkg(): TreePackage | null;
    get failed(): string | undefined;
    get verdicts(): HostVerdicts;
    /** The root of its tree: the project, or a virtual root (`this === this.root`). */
    get isProjectRoot(): boolean;
    /** A top-level package of a global prefix. */
    get globalTop(): boolean;
    get isTop(): boolean;
    get version(): string | null;
    get location(): string;
    /** Folders below its top: a top (the project, a virtual root, a global prefix's package) is at 0. */
    get depth(): number;
    isDescendantOf(ancestor: Node<H>): boolean;
    /** The copy Node's walk finds for `name` from here. */
    resolve(name: string): Node<H> | null;
    satisfies(edge: Edge<H>): boolean;
    /** The same package (Node.matches): by integrity where both know it, else the same package at the same version. */
    matches(other: Node<H>): boolean;
    /** Whether `this` may stand in for `old`: every edge into `old` from outside what only `old` needs accepts it (canReplaceWith). */
    canReplace(old: Node<H>, ignorePeers?: Iterable<string>): boolean;
    /** Whether it came in a package's archive: a name its parent, or an ancestor between, bundles (inDepBundle). */
    get inDepBundle(): boolean;
    /** Whether it is a needless copy: nothing wants it, or a copy two folders up does as well; never a bundled one (canDedupe). */
    canDedupe(preferDedupe: boolean): boolean;
}
/** One tree of nodes (the ideal tree, or a virtual root's), every edge's target kept current as nodes come and go. */
export declare class Tree<H extends HostPackages> {
    readonly root: Node<H>;
    readonly global: boolean;
    private readonly edgesByName;
    private readonly byName;
    /**
     * Every node in the tree, the root first, in the order each joined it
     * (npm's inventory): a node moved within the tree keeps its place, as
     * npm's keeps a node whose root does not change.
     */
    readonly inventory: Set<Node<H>>;
    constructor(root: Node<H>, global: boolean);
    named(name: string): ReadonlySet<Node<H>>;
    /** Whether anything in the tree is, or asks for, `name`. */
    mentions(name: string): boolean;
    nodes(): Generator<Node<H>>;
    /** Put `node` in `parent`'s node_modules, where what was there goes. */
    attach(node: Node<H>, parent: Node<H>): void;
    /** Put `node` where `old` is: it takes what `old` holds (Node.replace). */
    replace(node: Node<H>, old: Node<H>): void;
    /** Take `node`, and what is beneath it, out of the tree. */
    detach(node: Node<H>): void;
    /** `node` out of its folder; `moving`: to another in this tree, its place in the inventory kept. */
    private take;
    private register;
    private unregister;
    /** Every edge for `name` from `parent` or beneath it, retargeted. */
    private reload;
    private retarget;
}
/** Every node beneath `node`'s folder. */
export declare function descendants<H extends HostPackages>(node: Node<H>): Generator<Node<H>>;
//# sourceMappingURL=model.d.ts.map