/**
 * npm-arborist.ts — npm's one install engine: the ideal tree an install
 * reifies, built as npm 10.9.8's arborist builds it (build-ideal-tree.js,
 * place-dep.js, can-place-dep.js, calc-dep-flags.js, optional-set.js,
 * gather-dep-set.js, peer-entry-sets.js, deepest-nesting-target.js), over
 * the tree a host says is installed and from what it resolves. Both hosts
 * install through it (worker npm/installer.ts, lifo commands/system/npm.ts).
 *
 * The tree is nodes in node_modules folders and the edges between them; an
 * edge goes to the copy Node's walk finds from its dependent. The build
 * visits nodes, not edges: a queue of nodes, the shallowest first, each
 * visited once while it is in the tree. A node's problem edges (unmet,
 * invalid, or named on the command line) are each resolved into a virtual
 * root (a copy of the dependent, outside the tree) with the package's peer
 * set, and placed as PlaceDep places them: from the deepest place it may go
 * up toward the root, at the highest place where neither it nor any of its
 * peers conflicts, the peers with it. A copy there may be kept, replaced
 * (what only the replaced copy needed goes with it), or left in conflict:
 * a peer conflict the project owns is npm's ERESOLVE unless forced, and
 * another's a warning.
 *
 * Then calc-dep-flags marks what the project reaches. What it does not is
 * extraneous, and goes where a tree was installed before (#fixDepFlags'
 * prune: npm with its lockfile, for which a changed tree is always
 * suspect); a tree built from nothing keeps what its build left unreached,
 * as npm installs it. What only optional edges reach is optional. A package that failed to load,
 * or that the host refuses (EBADPLATFORM), fails the install where it is
 * required and is left out with its optional set where it is optional.
 *
 * A frozen plan (npm ci) builds nothing: the tree is the one the lock
 * records, given as installed; only its flags and failures are found.
 */
import { type TreeEdge, type TreePackage, type TreeRoot } from './npm-tree.js';
/** What a host answers for a request it resolves. */
export type TreeResolution<P extends TreePackage> = 
/**
 * The package for the request (under the requested name). `refused`: the
 * host cannot install it (a platform it cannot run), which fails a
 * required placement and leaves an optional one out; `skipIfOptional`: it
 * installs where required, and is left out where optional.
 */
{
    readonly package: P;
    readonly refused?: string;
    readonly skipIfOptional?: string;
}
/** Not resolved: no such package or version, or the registry failed. */
 | {
    readonly failed: string;
};
/**
 * A package installed before this install, at its placement (`refused` and
 * `skipIfOptional` as a resolution's); or, in a frozen tree, a placement the
 * host cannot install at all, with why.
 */
export type InstalledPackage<I extends TreePackage> = {
    readonly at: string;
    readonly pkg: I;
    readonly refused?: string;
    readonly skipIfOptional?: string;
} | {
    readonly at: string;
    readonly failed: string;
};
/** What the plan is built from: `P`, the packages it resolves. */
export interface TreeHost<P extends TreePackage> {
    /** Resolve requests together; an answer per request, in order. */
    resolve(requests: ReadonlyArray<{
        readonly name: string;
        readonly range: string;
    }>): Promise<ReadonlyArray<TreeResolution<P>>>;
    /** A peer conflict npm lets through (another's, or forced): what it says. */
    warn?(message: string): void | Promise<void>;
}
export interface PlanOptions {
    /** Global installs: npm's shallow layout (dependencies stay beneath the top-level package that needs them; its peers are not placed with it). */
    readonly shallow?: boolean;
    /** `--force`: a peer conflict the project owns is a warning, not ERESOLVE. */
    readonly force?: boolean;
    /** `--legacy-peer-deps`: peers are not edges at all. */
    readonly legacyPeerDeps?: boolean;
    /** npm ci: the installed tree is the plan; nothing is resolved or moved. */
    readonly frozen?: boolean;
}
/** What the plan could not meet: a package at `id` (its placement) that failed or is refused, or the project's peer conflict. */
export interface TreeFailure {
    readonly edge: TreeEdge;
    readonly reason: string;
    /** The host refused it; else it could not be resolved, nested, or its peers met. */
    readonly refused: boolean;
    readonly id: string;
}
/** A placement of the tree: a package placed by this install, or one installed before it that the tree keeps. */
export type TreeNode<P extends TreePackage, I extends TreePackage> = {
    readonly at: string;
    readonly planned: true;
    readonly pkg: P;
    readonly edge: TreeEdge;
} | {
    readonly at: string;
    readonly planned: false;
    readonly pkg: I;
};
export interface TreePlan<P extends TreePackage, I extends TreePackage> {
    /** The tree, by placement: placed and kept packages alike, the skipped among them. */
    readonly nodes: ReadonlyMap<string, TreeNode<P, I>>;
    /** Whether the build asked the host to resolve anything. */
    readonly resolvedAny: boolean;
    readonly failures: readonly TreeFailure[];
    /** Placements (and failure ids) a path of required edges reaches from the project. */
    readonly required: ReadonlySet<string>;
    /** Placements (and failure ids) left out: optional failures and refusals, what the host leaves out, and their optional sets. */
    readonly skipped: ReadonlySet<string>;
    /** Why each one left out is (by placement or failure id). */
    readonly reasons: ReadonlyMap<string, string>;
    /** Installed placements the tree does not keep. */
    readonly extraneous: ReadonlySet<string>;
    /**
     * Leave out `at`, which failed after the plan (its download, its
     * archive), with its optional set: every placement left out so far, or
     * null when it is required and fails the install.
     */
    fail(at: string, reason: string): ReadonlySet<string> | null;
}
/** The required failures of `plan`: any fails the install. */
export declare function requiredFailures(plan: Pick<TreePlan<TreePackage, TreePackage>, 'failures' | 'required'>): TreeFailure[];
/** Plan the tree `roots` need over what is `installed`, from what `host` answers. */
export declare function planTree<P extends TreePackage, I extends TreePackage>(roots: readonly TreeRoot[], installed: ReadonlyArray<InstalledPackage<I>>, host: TreeHost<P>, options?: PlanOptions): Promise<TreePlan<P, I>>;
//# sourceMappingURL=npm-arborist.d.ts.map