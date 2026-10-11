/**
 * npm-tree.ts — the plan of npm's one install engine: the tree a set of
 * roots needs, built as npm's arborist builds it, from what a host answers.
 * Both hosts install through it: the worker's (worker npm/installer.ts:
 * resolver facets a layer at a time, the lockfile for what is installed) and
 * the shell's own (lifo commands/system/npm.ts shellInstallPort: the registry
 * one package at a time, node_modules for what is installed).
 *
 * One breadth-first walk over every root's edges puts each package where the
 * rule both share says (npm-placement.ts). A package already installed is a
 * copy the walk sees and keeps when it meets an edge; a kept package's own
 * edges are walked again, so a replacement elsewhere in the tree (a root
 * upgraded past a dependent's range) nests the copy that dependent needs.
 *
 * A placement is required when a path of required edges reaches it from a
 * root; the rest is optional: every path to it passes through an
 * optionalDependencies edge (or an optional root). One that cannot be placed
 * (unresolved, refused, too deep) fails the install when required; when
 * optional it is skipped, with what needs it on the way and what only they
 * need, as arborist skips an optional dependency's set.
 */
import { type PlacementEdge } from './npm-placement.js';
/** An edge of the tree: optional when it is an optionalDependencies entry (or an optional root). */
export type TreeEdge = PlacementEdge & {
    readonly optional: boolean;
};
/** The fields of a manifest its edges are read from. */
export interface TreeManifest {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
    readonly peerDependenciesMeta?: Readonly<Record<string, {
        readonly optional?: boolean;
    } | undefined>>;
}
/** A package a host knows: its name, version and manifest. */
export interface TreePackage extends TreeManifest {
    readonly name: string;
    readonly version: string;
}
/**
 * The edges a manifest asks for from `from`, as npm reads them: one per name
 * among its dependencies and optional ones (an optionalDependencies entry
 * overrides a dependencies one), and the peers it requires.
 */
export declare function manifestEdges(manifest: TreeManifest, from: string): TreeEdge[];
/** What a host answers for an edge it resolves. */
export type TreeResolution<P extends TreePackage> = 
/**
 * The package for the edge; one of another name (the host swapped it) is
 * placed under that name. With `skipIfOptional`, the host leaves it out
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
/** What the plan is built from. */
export interface TreeHost<P extends TreePackage> {
    /** Resolve a layer of edges, together, each for its placement (`at`); an answer per edge, in order. */
    resolve(layer: ReadonlyArray<{
        readonly edge: TreeEdge;
        readonly at: string;
    }>): Promise<ReadonlyArray<TreeResolution<P>>>;
    /** The packages already at `placements`, before this install; null where there is none. */
    installed(placements: readonly string[]): Promise<ReadonlyArray<P | null>>;
    /** A peer met by a copy outside its range, as npm warns of one. */
    peerMismatch?(edge: TreeEdge, at: string, version: string): void | Promise<void>;
}
/** A placement the plan could not fill. */
export interface TreeFailure {
    readonly edge: TreeEdge;
    readonly at: string;
    readonly reason: string;
    /** The host refused it; else it could not be resolved (or would nest too deep). */
    readonly refused: boolean;
}
export interface TreePlan<P extends TreePackage> {
    /** Packages to place, in the order the walk decided them; `at` is their placement. */
    readonly planned: ReadonlyArray<{
        readonly edge: TreeEdge;
        readonly at: string;
        readonly pkg: P;
    }>;
    /** Packages already installed that the tree keeps, by placement. */
    readonly kept: ReadonlyMap<string, P>;
    /** Placements that could not be filled; a required one fails the install. */
    readonly failures: readonly TreeFailure[];
    /** Placements reached from a root by a path of required edges. */
    readonly required: ReadonlySet<string>;
    /**
     * Placements left out: optional ones that failed or that their host leaves
     * out when optional (`reasons`), what needs them, and what only those
     * need. A kept package among them is removed.
     */
    readonly skipped: ReadonlySet<string>;
    /** Why each optional placement that failed, or that its host left out, is skipped. */
    readonly reasons: ReadonlyMap<string, string>;
    /**
     * Skip `at`, which failed after the plan (its download, its archive), with
     * what it takes along; false, and nothing skipped, when it is required.
     */
    skip(at: string, reason: string): boolean;
}
/** A root of the tree: a project's dependency, or a package named to install. */
export interface TreeRoot {
    readonly name: string;
    readonly range: string;
    /** An optionalDependencies entry of the project. */
    readonly optional?: boolean;
}
/**
 * A project's roots, as npm installs them: its dependencies, its
 * devDependencies (unless `production`; a name in both is a dependency), its
 * optionalDependencies (optional, over the same name elsewhere), and the
 * packages named on the command line, which win their names.
 */
export declare function projectRoots(manifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
} | null, named: ReadonlyArray<{
    readonly name: string;
    readonly range: string | null;
}>, { production }?: {
    production?: boolean;
}): TreeRoot[];
/** Plan the tree `roots` need, from what `host` answers. */
export declare function planTree<P extends TreePackage>(roots: readonly TreeRoot[], host: TreeHost<P>): Promise<TreePlan<P>>;
/** The required placements of `plan` that could not be filled: any fails the install. */
export declare function requiredFailures(plan: Pick<TreePlan<TreePackage>, 'failures' | 'required'>): TreeFailure[];
/** `run` once no other install into the tree at `canonical` in `namespace` is running. */
export declare function withTreeLock<T>(namespace: object, canonical: string, run: () => Promise<T>): Promise<T>;
/**
 * Where `path` is: its deepest existing ancestor resolved through symlinks
 * (`realpath`), and the rest of it, which does not exist yet.
 */
export declare function canonicalTreePath(realpath: (path: string) => Promise<string>, path: string): Promise<string>;
//# sourceMappingURL=npm-tree.d.ts.map