/**
 * build.ts — the ideal tree's build (build-ideal-tree.js #buildDeps): a
 * queue of nodes, the shallowest first, each visited once while it is in the
 * tree. A node's problem edges (unmet, invalid, or named on the command
 * line) are each resolved into a virtual root (a copy of the dependent,
 * outside the tree) with the package's peer set, and placed (place-dep.ts);
 * what a placement leaves unmet is queued again.
 */
import { type TreePackage } from '../npm-tree.js';
import { Node, Tree, type EdgeDefinition, type HostPackages } from './model.js';
import { Placer } from './place-dep.js';
import type { PlanOptions, TreeHost, TreeResolution } from './plan.js';
export declare class Builder<H extends HostPackages> {
    readonly tree: Tree<H>;
    private readonly host;
    private readonly options;
    /** Nodes that failed to load: their edges are no problem to solve. */
    readonly loadFailures: Set<Node<H>>;
    readonly placer: Placer<H>;
    readonly resolutions: Map<string, TreeResolution<H["resolved"]>>;
    /** Whether a placement changed the tree (#mutateTree). */
    mutated: boolean;
    private queue;
    private readonly queued;
    private queueSorted;
    /** Requests whose package's edges prefetch has asked for. */
    private readonly expanded;
    private readonly seen;
    private readonly virtualRoots;
    /** A package's edges, read from its manifest once. */
    private readonly edgeDefinitions;
    constructor(tree: Tree<H>, host: TreeHost<H['resolved']>, options: PlanOptions);
    edgesOf(pkg: TreePackage | null): EdgeDefinition[];
    private push;
    private pop;
    private requestKey;
    /**
     * Resolve every request not yet answered, together. One no registry
     * answers (a git, file, directory or URL spec) fails here, without asking:
     * npm installs it from where it points, which this engine does not.
     */
    private resolve;
    /** The node `name@spec` resolves to, in `parent` (a virtual root): its package, or a load failure (#nodeFromSpec). */
    private nodeFromSpec;
    /** A root outside the tree with `source`'s edges, where a package and its peer set are loaded (#virtualRoot). */
    private virtualRoot;
    /** The package for `edge`, loaded with its peer set into a virtual root (#nodeFromEdge). */
    private nodeFromEdge;
    /** Load `node`'s peers, and theirs, into its virtual root (#loadPeerSet). */
    private loadPeerSet;
    /** A node's problem edges: unmet (but an optional peer's), invalid, or named on the command line (#problemEdges); what its archive bundles is its own. */
    private problemEdges;
    /**
     * What the coming visits will ask, resolved ahead, a level at a time: the
     * queue's problem edges, then every edge of what they resolve to (a peer
     * also at its source's own spec, which its peer set prefers), and so on
     * down. Resolution is the host's round trip; this keeps the trips to the
     * depth of the tree, not its width. A request is expanded once.
     */
    private prefetch;
    build(): Promise<void>;
    private visit;
}
//# sourceMappingURL=build.d.ts.map