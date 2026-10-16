/**
 * plan.ts — npm's one install engine, as its hosts use it (worker
 * npm/installer.ts, lifo commands/system/npm.ts): the ideal tree an install
 * reifies, built as npm 10.9.8's arborist builds it over the tree a host
 * says is installed and from what it resolves (build.ts), its dependency
 * flags found (flags.ts), and what cannot be installed failed or left out.
 *
 * What the project does not reach is extraneous, and goes where a tree was
 * installed before; a tree built from nothing keeps what its build left
 * unreached, as npm installs it. A package that failed to load, or that the
 * host refuses (EBADPLATFORM), fails the install where it is required and is
 * left out with its optional set where it is optional.
 *
 * npm ci plans over the lock's tree as an install does, and the plan must
 * be the lock's (validate-lockfile): `lockMismatches` names what it is not.
 * The lock's own flags are kept, unless the build changed the tree or the
 * lock's root declares other dependencies than the project; then they are
 * found again, and what the project does not reach goes.
 */
import { type TreeEdge, type TreePackage, type TreeRoot } from '../npm-tree.js';
/** What a lock says of an entry (load-virtual keeps them): flags npm ci uses instead of computing them. */
export interface LockFlags {
    readonly dev?: boolean;
    readonly optional?: boolean;
    readonly devOptional?: boolean;
    readonly peer?: boolean;
    readonly extraneous?: boolean;
}
/** The dependency types `--omit` names. */
export interface OmitTypes {
    readonly dev?: boolean;
    readonly optional?: boolean;
    readonly peer?: boolean;
}
/**
 * Why a host would leave a package out. `refused`: the host cannot install it
 * (a platform it cannot run), which fails a required placement and leaves an
 * optional one out; `skipIfOptional`: it installs where required, and is
 * left out where optional.
 */
export interface HostVerdicts {
    readonly refused?: string;
    readonly skipIfOptional?: string;
}
/** What a host answers for a request it resolves. */
export type TreeResolution<P extends TreePackage> = 
/** The package for the request (under the requested name), with the host's verdicts on it. */
({
    readonly package: P;
} & HostVerdicts)
/** Not resolved: no such package or version, or the registry failed. */
 | {
    readonly failed: string;
};
/**
 * A package installed before this install, at its placement, with the
 * host's verdicts on it (`lock`, the flags a lock records for it); or a
 * placement whose package the host cannot install at all, with why.
 */
export type InstalledPackage<I extends TreePackage> = ({
    readonly at: string;
    readonly pkg: I;
    readonly lock?: LockFlags;
} & HostVerdicts) | {
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
    /** A global prefix: its top-level packages are tops, and each keeps its dependencies beneath it (npm's shallow strategy). */
    readonly global?: boolean;
    /** `--force`: a peer conflict the project owns is a warning, not ERESOLVE. */
    readonly force?: boolean;
    /** `--strict-peer-deps`: another's peer conflict is ERESOLVE too, unless forced. */
    readonly strictPeerDeps?: boolean;
    /** `--legacy-peer-deps`: peers are not edges at all. */
    readonly legacyPeerDeps?: boolean;
    /**
     * npm ci: `installed` is the lock's tree, which the plan must be;
     * 'suspect' where the lock's root declares other dependencies than the
     * project does (load-virtual checkRootEdges, lockRootMatches).
     */
    readonly locked?: 'trusted' | 'suspect';
    /** `--prefer-dedupe`: an installed copy is replaced by an older one that meets every edge too. */
    readonly preferDedupe?: boolean;
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
    /** The tree, by placement: placed and kept packages alike, the skipped among them, in the order each joined it (npm's inventory). */
    readonly nodes: ReadonlyMap<string, TreeNode<P, I>>;
    /** Whether the build asked the host to resolve anything. */
    readonly resolvedAny: boolean;
    readonly failures: readonly TreeFailure[];
    /** npm ci: how the plan is not the lock's tree (validate-lockfile's lines); empty when it is. */
    readonly lockMismatches: readonly string[];
    /** Placements (and failure ids) a path of required edges reaches from the project. */
    readonly required: ReadonlySet<string>;
    /** Whether `--omit` leaves `at` out at reification (reify's filter over calc-dep-flags' flags). */
    omits(at: string, omit: OmitTypes): boolean;
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
//# sourceMappingURL=plan.d.ts.map