/**
 * npm-tree.ts — the vocabulary of npm's one install engine, shared by the
 * engine (npm-arborist/, which builds the tree) and its two hosts (worker
 * npm/installer.ts and lifo commands/system/npm.ts): placements, manifests
 * and their edges, a project's roots, what the command line names and how it
 * is saved, and one install into a tree at a time.
 *
 * Placements are paths relative to the project's node_modules: `react` at
 * root, `pkg/node_modules/dep` nested. Node walks node_modules upward from
 * the importer, so a nested copy is found by its dependent and what is
 * beneath it, and by nobody else.
 */
/** The containing placement, `''` at root. */
export declare function parentPlacement(placement: string): string;
/** The package name a placement holds. */
export declare function placementName(placement: string): string;
/** How deep a placement is: 1 at root. */
export declare function depthOf(placement: string): number;
/**
 * A cycle with mutually incompatible ranges has no finite layout without
 * links: a request that would nest deeper than this fails rather than
 * nesting without end.
 */
export declare const MAX_NEST_DEPTH = 16;
/** A name → range map. */
export type DependencyMap = Readonly<Record<string, string>>;
/** The fields of a manifest its edges are read from. */
export interface TreeManifest {
    readonly dependencies?: DependencyMap;
    readonly optionalDependencies?: DependencyMap;
    readonly peerDependencies?: DependencyMap;
    readonly peerDependenciesMeta?: Readonly<Record<string, {
        readonly optional?: boolean;
    }>>;
    /** `bundleDependencies` as published (npm also reads `bundledDependencies`): what its archive carries in its own node_modules, read by bundledNames. */
    readonly bundleDependencies?: unknown;
}
/** The names a manifest bundles: its `bundleDependencies` list, or every dependency for `true`. They are not resolved, nor deduped away. */
export declare function bundledNames(manifest: TreeManifest): string[];
/** A package a host knows: its name and version, and the manifest its edges are read from. */
export interface TreePackage extends TreeManifest {
    /** The name it is installed under (an alias's). */
    readonly name: string;
    readonly version: string;
    /** The registry package it is, where the host knows it (npm's packageName: an alias's target). */
    readonly registryName?: string;
    /** Its content's integrity, where the host knows it: two copies with it are the same package (Node.matches). */
    readonly integrity?: string;
}
/** npm's edge types: what a dependency is to the package that asks for it. */
export type EdgeType = 'prod' | 'dev' | 'optional' | 'peer' | 'peerOptional';
/** A dependency edge: `name` at `range` (an `npm:` alias's included), asked for by the package at `from` (`''`: the project). */
export interface TreeEdge {
    readonly name: string;
    readonly range: string;
    readonly from: string;
    readonly type: EdgeType;
    /** Named on the command line: resolved even where an installed copy already meets it. */
    readonly explicit: boolean;
}
/** A peer edge: placed with the package that asks for it. */
export declare function isPeer(type: EdgeType): boolean;
/** An optional edge: its failure is no failure of the package that asks for it. */
export declare function isOptional(type: EdgeType): boolean;
/**
 * The edges a manifest asks for, as npm's Node loads them (_loadDeps), the
 * later replacing the earlier of one name: its peers (an optional one is
 * peerOptional: not installed where absent, and constraining where present),
 * then its dependencies, then its optional dependencies. `legacyPeerDeps`:
 * peers are not loaded at all.
 */
export declare function manifestEdges(manifest: TreeManifest, { legacyPeerDeps }?: {
    legacyPeerDeps?: boolean | undefined;
}): Array<Pick<TreeEdge, 'name' | 'range' | 'type'>>;
/** What an edge's spec asks for: the registry package (an `npm:` alias's target), and its semver range, or null for a spec that is not one (a tag, `*`). */
export interface EdgeRequest {
    readonly registryName: string;
    readonly range: string | null;
    /** Whether a registry answers it; a git, file, directory or URL spec is not installed here. */
    readonly registry: boolean;
}
export declare function edgeRequest(name: string, spec: string): EdgeRequest;
/** Whether `version` meets an edge's range, as npm's dep-valid reckons it: any version, for a spec that is not a range. */
export declare function meets(version: string, edge: Pick<TreeEdge, 'name' | 'range'>): boolean;
/** The project's package.json, as its roots and saves read it. */
export interface ProjectManifest extends TreeManifest {
    readonly devDependencies?: DependencyMap;
}
/** package.json, read: the document as written (every field, for saving), and the dependencies npm reads from it. */
export interface PackageJsonDocument {
    readonly json: Readonly<Record<string, unknown>>;
    readonly manifest: ProjectManifest;
}
/** A parsed package.json; null where it is not an object. */
export declare function packageJsonDocument(value: unknown): PackageJsonDocument | null;
/** package.json's text, read; null where it is not JSON, or not an object. */
export declare function readPackageJson(text: string): PackageJsonDocument | null;
/** A root of the tree: an edge from the project. */
export interface TreeRoot {
    readonly name: string;
    readonly range: string;
    readonly type: EdgeType;
    /** Named on the command line: resolved even where an installed copy meets it. */
    readonly explicit?: boolean;
}
/** Where a named package is saved: npm's save types. */
export type SaveType = 'prod' | 'dev' | 'optional' | 'peer' | 'peerOptional';
/** The save type npm infers for `name` from where the project declares it (add-rm-pkg-deps inferSaveType); prod when it does not. */
export declare function inferSaveType(manifest: ProjectManifest | null, name: string): SaveType;
/** A package named on the command line: `name`, the spec it gives (null: none), and where it is saved (`explicit`: a flag said so; else inferred). */
export interface NamedPackage {
    readonly name: string;
    readonly range: string | null;
    readonly saveType: SaveType;
    readonly explicit: boolean;
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
 * A project's roots, as npm's Node loads the root's edges, the later
 * replacing the earlier of one name: its peers, dependencies and optional
 * dependencies (manifestEdges), then its devDependencies; then the packages
 * named on the command line, explicit requests of their save type. The
 * tree is planned whole: `--omit=dev` leaves out at reification what only
 * devDependencies reach (TreePlan.omits). A global prefix has no manifest:
 * its roots are what the command line names.
 */
export declare function projectRoots(manifest: ProjectManifest | null, named: readonly NamedPackage[], { legacyPeerDeps }?: {
    legacyPeerDeps?: boolean;
}): TreeRoot[];
/**
 * Whether a lock's root (`lockRoot`, its package.json fields) declares what
 * the project's `roots` are (load-virtual checkRootEdges): every dependency
 * of every type it records is a root of that type at that spec, and there
 * is no other root.
 */
export declare function lockRootMatches(lockRoot: ProjectManifest, roots: readonly TreeRoot[]): boolean;
/**
 * package.json (`json`, as parsed) with what the command line named saved,
 * as npm saves it: first added where its save type goes and out of the
 * fields that type excludes (add-rm-pkg-deps add), then, once it installed
 * (`installed`: the version under its name), saved at `^version` unless the
 * spec given is a range `^version` would widen, an alias as the package it
 * names (reify #saveIdealTree). An explicit save type writes that field; an
 * inferred one updates every field that names it, but a peer or optional
 * range a dev one still intersects. One that did not install keeps the
 * spec given. As npm writes package.json, a name in optionalDependencies is
 * not repeated in dependencies. Every other field is as it was.
 */
export declare function saveNamed(json: Readonly<Record<string, unknown>>, named: readonly NamedPackage[], installed: (name: string) => string | null, 
/** npm's save-prefix: '' for `--save-exact`. */
savePrefix?: string): Record<string, unknown>;
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