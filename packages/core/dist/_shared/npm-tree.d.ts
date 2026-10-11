/**
 * npm-tree.ts — npm's one install engine: the ideal tree a project's roots
 * need, built as npm's arborist builds it (build-ideal-tree, place-dep,
 * can-place-dep, calc-dep-flags, optional-set), from what a host answers.
 * Both hosts install through it: the worker's (worker npm/installer.ts:
 * resolver facets a layer at a time, its lockfile for what is installed) and
 * the shell's own (lifo commands/system/npm.ts shellInstallPort: the
 * registry one package at a time, node_modules for what is installed).
 *
 * Placements are paths relative to the project's node_modules: `react` at
 * root, `pkg/node_modules/dep` nested. Node walks node_modules upward from
 * the importer, so a nested copy is found by its dependent and what is
 * beneath it, and by nobody else.
 *
 * The walk is breadth-first, a layer at a time, each layer's edges in npm's
 * order (by the dependent's depth and path, then by name). An edge already
 * met by the copy Node's walk finds from its dependent stays as it is; any
 * other, and every edge the command line names (an explicit request), is
 * resolved and placed as PlaceDep places it: from the dependent (a peer:
 * from the dependent's parent) up toward the root, at the highest place
 * where it does not conflict. A copy there that the new one may replace (it
 * is no newer, and everything relying on it accepts the new one) is
 * replaced; one that already meets the edge is kept; a copy the new one
 * would shadow from something beneath that needs it is a conflict. What is
 * installed is read as the walk reaches it: a copy no edge meets is not part
 * of the tree, and goes.
 *
 * A request that cannot be met (unresolved, refused, too deep, a peer
 * conflict with the project's own dependency) is a failure of that request,
 * not of its place: another request for the same name places on its own. A
 * placement is required when a path of required edges reaches it from the
 * project; the rest is optional. A required failure fails the install; an
 * optional one is left out with its optional set (optional-set.js): what
 * needs it up to the optionalDependencies edges into the set, and what only
 * those need.
 */
/** `name` under `parent`; `''` is the project itself. */
export declare function nestedPlacement(parent: string, name: string): string;
/** The containing placement, `''` at root. */
export declare function parentPlacement(placement: string): string;
/** The package name a placement holds. */
export declare function placementName(placement: string): string;
/** How deep a placement is: 1 at root. */
export declare function depthOf(placement: string): number;
/** Placements Node's walk visits for `name` from inside `from`, nearest first, root last. */
export declare function visiblePlacements(from: string, name: string): string[];
/**
 * A cycle with mutually incompatible ranges has no finite layout without
 * links: a request that would nest deeper than this fails rather than
 * nesting without end.
 */
export declare const MAX_NEST_DEPTH = 16;
/** The fields of a manifest its edges are read from. */
export interface TreeManifest {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
    readonly peerDependenciesMeta?: Readonly<Record<string, {
        readonly optional?: boolean;
    } | undefined>>;
}
/** A package a host knows: its name and version, and the manifest its edges are read from. */
export interface TreePackage extends TreeManifest {
    readonly name: string;
    readonly version: string;
}
/** A dependency edge: `name` at `range` (an `npm:` alias's included), asked for by the package at `from` (`''`: the project). */
export interface TreeEdge {
    readonly name: string;
    readonly range: string;
    readonly from: string;
    readonly kind: 'dep' | 'peer';
    /** An optionalDependencies entry (or an optional root): its failure skips its set. */
    readonly optional: boolean;
    /** Named on the command line: resolved even where an installed copy already meets it. */
    readonly explicit: boolean;
}
/**
 * The edges a manifest asks for from `from`, as npm's Node loads them: the
 * peers it requires, then its dependencies, then its optional dependencies
 * (an optionalDependencies entry replaces a dependencies one).
 */
export declare function manifestEdges(manifest: TreeManifest, from: string): TreeEdge[];
/** A root of the tree: an edge from the project. */
export interface TreeRoot {
    readonly name: string;
    readonly range: string;
    /** An optionalDependencies entry of the project. */
    readonly optional?: boolean;
    /** Named on the command line: resolved even where an installed copy meets it. */
    readonly explicit?: boolean;
}
/** The project's manifest, as its roots and saves read it. */
export interface ProjectManifest {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, {
        optional?: boolean;
    } | undefined>;
    [field: string]: unknown;
}
/** Where a named package is saved: npm's save types. */
export type SaveType = 'prod' | 'dev' | 'optional' | 'peer' | 'peerOptional';
/** The save type npm infers for `name` from where the project declares it (add-rm-pkg-deps inferSaveType); prod when it does not. */
export declare function inferSaveType(manifest: ProjectManifest | null, name: string): SaveType;
/** A package named on the command line: `name`, the spec it gives (null: none), and where it is saved. */
export interface NamedPackage {
    readonly name: string;
    readonly range: string | null;
    readonly saveType: SaveType;
}
/**
 * The packages a command line names, as npm adds them: each saved where the
 * flags say (`--save-dev`, `--save-optional`), else where the project
 * already declares it; a bare name (or `*`) the project declares keeps the
 * declared spec.
 */
export declare function namedPackages(manifest: ProjectManifest | null, specs: readonly string[], flags?: {
    saveDev?: boolean;
    saveOptional?: boolean;
}): NamedPackage[];
/**
 * A project's roots, as npm's Node loads its edges, the later replacing the
 * earlier of one name: its required peers, its dependencies, its optional
 * dependencies, its devDependencies (unless `production`); then the packages
 * named on the command line, explicit requests, optional where they are
 * saved as optional. `implicit`: names the project needs without declaring
 * them (a global prefix's installed packages), each met by what is there.
 */
export declare function projectRoots(manifest: ProjectManifest | null, named: readonly NamedPackage[], { production, implicit }?: {
    production?: boolean;
    implicit?: readonly string[];
}): TreeRoot[];
/**
 * The project's manifest with what the command line named saved, as npm
 * saves it after an install: each package that installed (`installed`: its
 * version, and its registry name when that is not the name it installs
 * under) under its save type, at `^version` unless the spec given is a range
 * `^version` would widen; out of the fields its save type excludes; an
 * optional one also under dependencies (npm's affordance for older npms).
 * One that did not install keeps the spec given.
 */
export declare function saveNamed(manifest: ProjectManifest, named: readonly NamedPackage[], installed: (name: string) => {
    version: string;
    registryName: string;
} | null): ProjectManifest;
/** What a host answers for a request it resolves. */
export type TreeResolution<P extends TreePackage> = 
/**
 * The package for the request; one of another name (the host swapped it)
 * is placed under that name. With `skipIfOptional`, the host leaves it out
 * when it turns out optional (a native binding it cannot run), saying why.
 */
{
    readonly package: P;
    readonly skipIfOptional?: string;
}
/** Not resolved: no such package or version, or the registry failed. */
 | {
    readonly failed: string;
}
/** Refused by the host (a platform it cannot run): a failure, which an optional placement skips. */
 | {
    readonly refused: string;
}
/** Left out by the host on purpose (a package it provides itself): no failure, and nothing placed. */
 | {
    readonly omitted: string;
};
/** What the plan is built from: `P`, the packages it resolves; `I`, those already installed. */
export interface TreeHost<P extends TreePackage, I extends TreePackage> {
    /** Resolve requests together (each name and range once); an answer per request, in order. */
    resolve(requests: ReadonlyArray<Pick<TreeEdge, 'name' | 'range' | 'optional'>>): Promise<ReadonlyArray<TreeResolution<P>>>;
    /** The packages installed at `placements` before this install; null where there is none. */
    installed(placements: readonly string[]): Promise<ReadonlyArray<I | null>>;
    /** A peer met by a copy outside its range, which npm allows where the conflict is not the project's own. */
    peerMismatch?(edge: TreeEdge, at: string, version: string): void | Promise<void>;
}
/** A request the plan could not meet. */
export interface TreeFailure {
    readonly edge: TreeEdge;
    readonly reason: string;
    /** The host refused it; else it could not be resolved, nest, or meet a peer. */
    readonly refused: boolean;
    /** Its id in the plan's graph: `required`, `skipped` and `reasons` name it so. */
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
    /** Requests the plan could not meet. */
    readonly failures: readonly TreeFailure[];
    /** Placements (and failure ids) a path of required edges reaches from the project. */
    readonly required: ReadonlySet<string>;
    /** Placements (and failure ids) left out: optional failures, what the host leaves out, and their optional sets. */
    readonly skipped: ReadonlySet<string>;
    /** Why each optional failure, or package its host leaves out, is left out (by placement or failure id). */
    readonly reasons: ReadonlyMap<string, string>;
    /** Installed placements the tree does not keep (extraneous now). */
    readonly extraneous: ReadonlySet<string>;
    /**
     * Leave out `at`, which failed after the plan (its download, its
     * archive), with its optional set: the placements left out (with any
     * already left out), or null when it is required and fails the install.
     */
    fail(at: string, reason: string): ReadonlySet<string> | null;
}
/** The required failures of `plan`: any fails the install. */
export declare function requiredFailures(plan: Pick<TreePlan<TreePackage, TreePackage>, 'failures' | 'required'>): TreeFailure[];
export interface PlanOptions {
    /** Global installs: dependencies stay beneath the package that needs them (npm's shallow strategy). */
    readonly shallow?: boolean;
    /** `--force` / `--legacy-peer-deps`: a peer conflict with the project's own dependency is a warning, not ERESOLVE. */
    readonly allowPeerConflicts?: boolean;
}
/** Plan the tree `roots` need, from what `host` answers. */
export declare function planTree<P extends TreePackage, I extends TreePackage>(roots: readonly TreeRoot[], host: TreeHost<P, I>, options?: PlanOptions): Promise<TreePlan<P, I>>;
/**
 * Hold the tree at `canonical` in `namespace` for one install, and give it
 * back with the release this answers, once the install is done: at once
 * when no install holds it, else (a promise) once those before have given it
 * back. One that `signal` stops while it waits never holds it (an AbortError).
 */
export declare function holdTree(namespace: object, canonical: string, signal?: AbortSignal): (() => void) | Promise<() => void>;
/**
 * Where `path` is: its deepest existing ancestor resolved through symlinks
 * (`realpath`), and the rest of it, which does not exist yet.
 */
export declare function canonicalTreePath(realpath: (path: string) => Promise<string>, path: string): Promise<string>;
//# sourceMappingURL=npm-tree.d.ts.map