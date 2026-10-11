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

import { isExactVersion, isSemverRange, rangeSubset, satisfiesRange, versionAtLeast } from './npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from './npm-spec.js';

// ── Placements ───────────────────────────────────────────────────────────────

const NM = '/node_modules/';

/** `name` under `parent`; `''` is the project itself. */
export function nestedPlacement(parent: string, name: string): string {
  return parent ? `${parent}${NM}${name}` : name;
}

/** The containing placement, `''` at root. */
export function parentPlacement(placement: string): string {
  const i = placement.lastIndexOf(NM);
  return i < 0 ? '' : placement.slice(0, i);
}

/** The package name a placement holds. */
export function placementName(placement: string): string {
  const i = placement.lastIndexOf(NM);
  return i < 0 ? placement : placement.slice(i + NM.length);
}

/** How deep a placement is: 1 at root. */
export function depthOf(placement: string): number {
  return placement === '' ? 0 : placement.split(NM).length;
}

/** Placements Node's walk visits for `name` from inside `from`, nearest first, root last. */
export function visiblePlacements(from: string, name: string): string[] {
  const out: string[] = [];
  let dir = from;
  while (dir) {
    out.push(`${dir}${NM}${name}`);
    dir = parentPlacement(dir);
  }
  out.push(name);
  return out;
}

/** Whether `placement` is `ancestor` or beneath it (`''`: everything is). */
function within(placement: string, ancestor: string): boolean {
  return ancestor === '' || placement === ancestor || placement.startsWith(ancestor + NM);
}

/**
 * A cycle with mutually incompatible ranges has no finite layout without
 * links: a request that would nest deeper than this fails rather than
 * nesting without end.
 */
export const MAX_NEST_DEPTH = 16;

// ── Packages and edges ───────────────────────────────────────────────────────

/** The fields of a manifest its edges are read from. */
export interface TreeManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean } | undefined>>;
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
export function manifestEdges(manifest: TreeManifest, from: string): TreeEdge[] {
  const byName = new Map<string, TreeEdge>();
  const optionalPeers = manifest.peerDependenciesMeta ?? {};
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (optionalPeers[name]?.optional !== true) byName.set(name, { name, range, from, kind: 'peer', optional: false, explicit: false });
  }
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) byName.set(name, { name, range, from, kind: 'dep', optional: false, explicit: false });
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) byName.set(name, { name, range, from, kind: 'dep', optional: true, explicit: false });
  return [...byName.values()];
}

/** Whether `version` meets an edge's `range`: any version, for a range that is not semver (a tag, a URL). */
function meets(version: string, edge: Pick<TreeEdge, 'name' | 'range'>): boolean {
  const { range } = parseRegistryRequest(edge.name, edge.range);
  return !isSemverRange(range) || satisfiesRange(version, range);
}

// ── Roots ────────────────────────────────────────────────────────────────────

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
  peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>;
  [field: string]: unknown;
}

/** Whether a parsed package.json is a manifest: a JSON object (an array is not). */
export function isManifest(value: unknown): value is ProjectManifest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a named package is saved: npm's save types. */
export type SaveType = 'prod' | 'dev' | 'optional' | 'peer' | 'peerOptional';

const SAVE_FIELD: Readonly<Record<SaveType, 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'>> = {
  prod: 'dependencies', dev: 'devDependencies', optional: 'optionalDependencies', peer: 'peerDependencies', peerOptional: 'peerDependencies',
};

/** The save type npm infers for `name` from where the project declares it (add-rm-pkg-deps inferSaveType); prod when it does not. */
export function inferSaveType(manifest: ProjectManifest | null, name: string): SaveType {
  for (const type of ['dev', 'optional', 'prod', 'peerOptional'] as const) {
    if (manifest?.[SAVE_FIELD[type]]?.[name] === undefined) continue;
    if (type === 'peerOptional' && manifest.peerDependenciesMeta?.[name]?.optional !== true) return 'peer';
    return type;
  }
  return 'prod';
}

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
export function namedPackages(manifest: ProjectManifest | null, specs: readonly string[], flags: { saveDev?: boolean; saveOptional?: boolean } = {}): NamedPackage[] {
  return specs.map((spec) => {
    const { name, range } = splitPackageSpec(spec);
    const saveType: SaveType = flags.saveDev ? 'dev' : flags.saveOptional ? 'optional' : inferSaveType(manifest, name);
    const declared = manifest?.[SAVE_FIELD[saveType]]?.[name];
    return { name, range: (range === null || range === '*') && declared !== undefined ? declared : range, saveType };
  });
}

/**
 * A project's roots, as npm's Node loads its edges, the later replacing the
 * earlier of one name: its required peers, its dependencies, its optional
 * dependencies, its devDependencies (unless `production`); then the packages
 * named on the command line, explicit requests, optional where they are
 * saved as optional. `implicit`: names the project needs without declaring
 * them (a global prefix's installed packages), each met by what is there.
 */
export function projectRoots(
  manifest: ProjectManifest | null,
  named: readonly NamedPackage[],
  { production = false, implicit = [] }: { production?: boolean; implicit?: readonly string[] } = {},
): TreeRoot[] {
  const roots = new Map<string, TreeRoot>();
  for (const name of implicit) roots.set(name, { name, range: '*' });
  for (const edge of manifestEdges(manifest ?? {}, '')) roots.set(edge.name, { name: edge.name, range: edge.range, optional: edge.optional });
  if (!production) {
    for (const [name, range] of Object.entries(manifest?.devDependencies ?? {})) roots.set(name, { name, range });
  }
  for (const { name, range, saveType } of named) {
    roots.set(name, { name, range: range ?? 'latest', optional: saveType === 'optional', explicit: true });
  }
  return [...roots.values()];
}

/**
 * The project's manifest with what the command line named saved, as npm
 * saves it after an install: each package that installed (`installed`: the
 * version under its name) under its save type, at `^version` unless the
 * spec given is a range `^version` would widen, an alias as the package it
 * names; out of the fields its save type excludes; an optional one also
 * under dependencies (npm's affordance for older npms). One that did not
 * install keeps the spec given.
 */
export function saveNamed(
  manifest: ProjectManifest,
  named: readonly NamedPackage[],
  installed: (name: string) => string | null,
): ProjectManifest {
  const out: ProjectManifest = { ...manifest };
  const field = (type: SaveType): Record<string, string> => {
    const key = SAVE_FIELD[type];
    const current = out[key];
    const copy = { ...current };
    out[key] = copy;
    return copy;
  };
  const remove = (key: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies', name: string) => {
    const current = out[key];
    if (current?.[name] === undefined) return;
    const { [name]: _gone, ...rest } = current;
    out[key] = rest;
  };
  for (const { name, range, saveType } of named) {
    if (saveType === 'prod') { remove('devDependencies', name); remove('peerDependencies', name); }
    else if (saveType === 'dev') remove('dependencies', name);
    else if (saveType === 'optional') remove('peerDependencies', name);
    else { remove('dependencies', name); remove('optionalDependencies', name); }
    const spec = range ?? '*';
    const version = installed(name);
    let saved = spec;
    if (version !== null) {
      // reify.js #saveIdealTree: a range the saved `^version` would widen is kept as given.
      const { range: requested, alias, registryName } = parseRegistryRequest(name, spec);
      const prefixed = `^${version}`;
      const isRange = isSemverRange(requested) && !isExactVersion(requested) && requested !== '*' && requested !== '' && requested !== 'latest';
      const range = isRange && !rangeSubset(prefixed, requested) ? requested : prefixed;
      saved = alias ? `npm:${registryName}@${range}` : range;
    }
    const target = field(saveType);
    if (saved !== '*' || target[name] === undefined) target[name] = saved;
    if (saveType === 'optional') field('prod')[name] = target[name];
  }
  return out;
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** What a host answers for a request it resolves. */
export type TreeResolution<P extends TreePackage> =
  /**
   * The package for the request; one of another name (the host swapped it)
   * is placed under that name. With `skipIfOptional`, the host leaves it out
   * when it turns out optional (a native binding it cannot run), saying why.
   */
  | { readonly package: P; readonly skipIfOptional?: string }
  /** Not resolved: no such package or version, or the registry failed. */
  | { readonly failed: string }
  /** Refused by the host (a platform it cannot run): a failure, which an optional placement skips. */
  | { readonly refused: string }
  /** Left out by the host on purpose (a package it provides itself): no failure, and nothing placed. */
  | { readonly omitted: string };

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
export type TreeNode<P extends TreePackage, I extends TreePackage> =
  | { readonly at: string; readonly planned: true; readonly pkg: P; readonly edge: TreeEdge }
  | { readonly at: string; readonly planned: false; readonly pkg: I };

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
export function requiredFailures(plan: Pick<TreePlan<TreePackage, TreePackage>, 'failures' | 'required'>): TreeFailure[] {
  return plan.failures.filter(({ id }) => plan.required.has(id));
}

/** A dependency graph edge: into `to` (a placement or failure id) from `from` (`''`: the project). */
interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly optional: boolean;
}

const localeCompare = (a: string, b: string): number => a.localeCompare(b, 'en');

/** npm's order for a layer: by the dependent's depth, its path, then the name. */
function npmOrder(a: TreeEdge, b: TreeEdge): number {
  return depthOf(a.from) - depthOf(b.from) || localeCompare(a.from, b.from) || localeCompare(a.name, b.name);
}

export interface PlanOptions {
  /** Global installs: dependencies stay beneath the package that needs them (npm's shallow strategy). */
  readonly shallow?: boolean;
  /** `--force` / `--legacy-peer-deps`: a peer conflict with the project's own dependency is a warning, not ERESOLVE. */
  readonly allowPeerConflicts?: boolean;
}

/** Plan the tree `roots` need, from what `host` answers. */
export async function planTree<P extends TreePackage, I extends TreePackage>(
  roots: readonly TreeRoot[],
  host: TreeHost<P, I>,
  options: PlanOptions = {},
): Promise<TreePlan<P, I>> {
  const rootEdges: TreeEdge[] = roots.map(({ name, range, optional, explicit }) => ({
    name, range, from: '', kind: 'dep', optional: optional === true, explicit: explicit === true,
  }));
  const nodes = new Map<string, TreeNode<P, I>>();
  // Installed packages read so far that no edge has met yet.
  const candidates = new Map<string, I>();
  const probed = new Set<string>();
  // Every edge of the tree (the project's, and each node's), by the name it asks for.
  const dependents = new Map<string, TreeEdge[]>();
  const index = (edges: readonly TreeEdge[]) => {
    for (const edge of edges) {
      const list = dependents.get(edge.name) ?? [];
      dependents.set(edge.name, list);
      list.push(edge);
    }
  };
  const unindex = (from: string) => {
    for (const [name, list] of dependents) dependents.set(name, list.filter((edge) => edge.from !== from));
  };
  index(rootEdges);
  const failures = new Map<string, TreeFailure>();
  // Who asked for each failed request (its graph's edges in), and which edges failed.
  const failedAskers = new Map<string, GraphEdge[]>();
  const failedEdges = new Set<string>();
  const omitted = new Set<string>();
  const whenOptional = new Map<string, string>();
  // Resolutions by request, for the life of the plan.
  const resolutions = new Map<string, TreeResolution<P>>();
  const rootNames = new Set(roots.map(({ name }) => name));
  const requestKey = (edge: Pick<TreeEdge, 'name' | 'range'>) => `${edge.name}\0${edge.range}`;

  const fail = (edge: TreeEdge, reason: string, refused: boolean) => {
    const id = `!${requestKey(edge)}`;
    if (!failures.has(id)) failures.set(id, { edge, reason, refused, id });
    const askers = failedAskers.get(id) ?? [];
    failedAskers.set(id, askers);
    askers.push({ from: edge.from, to: id, optional: edge.optional });
    failedEdges.add(`${edge.from}\0${edge.name}`);
  };

  // The package Node's walk finds for `name` from inside `from`, placed or installed.
  const nearest = (from: string, name: string): { at: string; pkg: TreePackage; kept: boolean } | null => {
    for (const at of visiblePlacements(from, name)) {
      const node = nodes.get(at);
      if (node) return { at, pkg: node.pkg, kept: true };
      const candidate = candidates.get(at);
      if (candidate) return { at, pkg: candidate, kept: false };
    }
    return null;
  };
  // The tree's edges for `name` that Node's walk answers from `at`.
  const reliersOn = (at: string, name: string): TreeEdge[] =>
    (dependents.get(name) ?? []).filter((edge) => nearest(edge.from, name)?.at === at);

  /** Keep the installed copy at `at`: it is part of the tree now, and its edges are walked. */
  const keep = (at: string, onward: (edges: readonly TreeEdge[]) => void) => {
    const candidate = candidates.get(at);
    if (!candidate) return;
    candidates.delete(at);
    nodes.set(at, { at, planned: false, pkg: candidate });
    const edges = manifestEdges(candidate, at);
    index(edges);
    onward(edges);
  };

  type Place = { kind: 'keep'; at: string } | { kind: 'place'; at: string } | { kind: 'conflict' };
  /** Whether `pkg` may go into `target`'s node_modules for `edge` (can-place-dep). */
  const canPlace = (edge: TreeEdge, pkg: TreePackage, target: string, deepest: string): Place => {
    const at = nestedPlacement(target, pkg.name);
    const current = nodes.get(at)?.pkg ?? candidates.get(at);
    if (current) {
      // checkCanPlaceCurrent.
      if (current.version === pkg.version && meets(current.version, edge)) return edge.explicit ? { kind: 'place', at } : { kind: 'keep', at };
      if (versionAtLeast(pkg.version, current.version) && reliersOn(at, pkg.name).every((e) => meets(pkg.version, e))) return { kind: 'place', at };
      if (meets(current.version, edge) && !edge.explicit) return { kind: 'keep', at };
      return target === deepest && edge.kind !== 'peer' ? { kind: 'place', at } : { kind: 'conflict' };
    }
    // checkCanPlaceNoCurrent: the target's own edge for the name must take
    // it, and what Node's walk from the target finds now must not be
    // shadowed from anything beneath that relies on it and the new copy
    // would not meet.
    const targetNode = target === '' ? null : nodes.get(target);
    const own = target === edge.from ? undefined
      : (target === '' ? rootEdges : targetNode ? manifestEdges(targetNode.pkg, target) : []).find((e) => e.name === pkg.name);
    if (own && !meets(pkg.version, own)) return { kind: 'conflict' };
    const visible = target === edge.from ? null : nearest(target, pkg.name);
    if (visible && reliersOn(visible.at, pkg.name).some((e) => within(e.from, target) && meets(visible.pkg.version, e) && !meets(pkg.version, e))) {
      return { kind: 'conflict' };
    }
    return { kind: 'place', at };
  };
  /** Where `pkg` goes for `edge`, as PlaceDep walks: from the deepest target up, the highest before a conflict. */
  const placeFor = (edge: TreeEdge, pkg: TreePackage): Place => {
    const deepest = edge.kind === 'peer' ? parentPlacement(edge.from) : edge.from;
    let found: Place = { kind: 'conflict' };
    for (let target = deepest; ; target = parentPlacement(target)) {
      const verdict = canPlace(edge, pkg, target, deepest);
      if (verdict.kind === 'conflict') break;
      found = verdict;
      if (verdict.kind === 'keep' || target === '') break;
      // npm's shallow strategy: nothing above a top-level package's own node_modules.
      if (options.shallow && parentPlacement(target) === '') break;
    }
    return found;
  };

  // A required root of the project's own: its peers conflicting with the project's own dependency are npm's ERESOLVE.
  const requiredRoots = new Set(rootEdges.filter(({ optional }) => !optional).map(({ name }) => name));
  /**
   * Settle `queue`'s edges: each met as it is, or resolved and placed. Edges
   * of what is placed or kept go to `next`, but required peers, which go to
   * `peers`: a package's peers are placed with it, before the next layer
   * (npm's peer set).
   */
  const settle = async (queue: TreeEdge[], next: TreeEdge[], peers: TreeEdge[]) => {
    const onward = (edges: readonly TreeEdge[]) => {
      for (const edge of edges) (edge.kind === 'peer' ? peers : next).push(edge);
    };
    queue.sort(npmOrder);
    // What is installed where these edges look, read once.
    const unprobed = [...new Set(queue.flatMap((edge) => visiblePlacements(edge.from, edge.name)))]
      .filter((at) => !probed.has(at) && !nodes.has(at));
    for (const at of unprobed) probed.add(at);
    if (unprobed.length > 0) {
      const found = await host.installed(unprobed);
      unprobed.forEach((at, i) => {
        const pkg = found[i];
        if (pkg) candidates.set(at, pkg);
      });
    }

    // Edges met as they are, and what is left to resolve: each request once.
    const toPlace: TreeEdge[] = [];
    for (const edge of queue) {
      const seen = edge.explicit ? null : nearest(edge.from, edge.name);
      if (seen && meets(seen.pkg.version, edge)) {
        keep(seen.at, onward);
        continue;
      }
      toPlace.push(edge);
    }
    const requests = [...new Map(toPlace.filter((edge) => !resolutions.has(requestKey(edge))).map((edge) => [requestKey(edge), edge])).values()];
    if (requests.length > 0) {
      const answers = await host.resolve(requests.map(({ name, range, optional }) => ({ name, range, optional })));
      requests.forEach((edge, i) => resolutions.set(requestKey(edge), answers[i] ?? { failed: 'the resolver returned no answer' }));
    }

    for (const edge of toPlace) {
      // An edge before it may have placed what meets it.
      const seen = edge.explicit ? null : nearest(edge.from, edge.name);
      if (seen?.kept && meets(seen.pkg.version, edge)) continue;
      const answer = resolutions.get(requestKey(edge)) ?? { failed: 'the resolver returned no answer' };
      if ('failed' in answer) { fail(edge, answer.failed, false); continue; }
      if ('refused' in answer) { fail(edge, answer.refused, true); continue; }
      if ('omitted' in answer) { omitted.add(requestKey(edge)); continue; }
      const { package: pkg } = answer;
      let place: Place;
      if (edge.kind === 'peer' && seen?.kept) {
        // A peer met by a copy at another version: the copy its range
        // resolves to replaces that one where everything relying on it takes
        // it too (build-ideal-tree's #loadPeerSet). Otherwise the conflict is
        // npm's ERESOLVE when it is the project's own (a required root's
        // peer against what the project depends on), and else its warning.
        if (reliersOn(seen.at, edge.name).every((e) => meets(pkg.version, e))) {
          place = { kind: 'place', at: seen.at };
        } else {
          const mine = parentPlacement(edge.from) === '' && requiredRoots.has(edge.from) && seen.at === edge.name && rootNames.has(edge.name);
          if (mine && !options.allowPeerConflicts) {
            fail(edge, `ERESOLVE: ${edge.from} needs peer ${edge.name}@${edge.range}, and the project depends on ${edge.name}@${seen.pkg.version}`, false);
          } else {
            await host.peerMismatch?.(edge, seen.at, seen.pkg.version);
          }
          continue;
        }
      } else {
        place = placeFor(edge, pkg);
      }
      if (place.kind === 'conflict') {
        if (edge.kind === 'peer' && seen) await host.peerMismatch?.(edge, seen.at, seen.pkg.version);
        else fail(edge, `${edge.name}@${edge.range} from ${edge.from || 'the project'} has no place: every copy it would replace or shadow is needed`, false);
        continue;
      }
      if (place.kind === 'keep') {
        keep(place.at, onward);
        continue;
      }
      if (depthOf(place.at) > MAX_NEST_DEPTH) {
        fail(edge, `${edge.name}@${edge.range} from ${edge.from} would nest deeper than ${MAX_NEST_DEPTH} levels (cycle with incompatible ranges)`, false);
        continue;
      }
      if (nodes.has(place.at)) unindex(place.at);
      candidates.delete(place.at);
      probed.add(place.at);
      nodes.set(place.at, { at: place.at, planned: true, pkg, edge });
      if (answer.skipIfOptional !== undefined) whenOptional.set(place.at, answer.skipIfOptional);
      const edges = manifestEdges(pkg, place.at);
      index(edges);
      onward(edges);
    }
  };

  for (let queue: TreeEdge[] = [...rootEdges]; queue.length > 0;) {
    const next: TreeEdge[] = [];
    for (let peers: TreeEdge[] = queue; peers.length > 0;) {
      const pending = peers;
      peers = [];
      await settle(pending, next, peers);
    }
    queue = next;
  }

  // ── The tree's graph: each edge into the copy Node's walk finds ──
  const edgesIn = new Map<string, GraphEdge[]>();
  const edgesOut = new Map<string, GraphEdge[]>();
  const link = (graphEdge: GraphEdge) => {
    const into = edgesIn.get(graphEdge.to) ?? [];
    edgesIn.set(graphEdge.to, into);
    into.push(graphEdge);
    const out = edgesOut.get(graphEdge.from) ?? [];
    edgesOut.set(graphEdge.from, out);
    out.push(graphEdge);
  };
  const linkEdges = (from: string, edges: readonly TreeEdge[]) => {
    for (const edge of edges) {
      if (failedEdges.has(`${from}\0${edge.name}`) || omitted.has(requestKey(edge))) continue;
      const to = visiblePlacements(from, edge.name).find((at) => nodes.has(at));
      if (to !== undefined) link({ from, to, optional: edge.optional });
    }
  };
  // Only what the project reaches is the tree: a copy a replacement left
  // unreferenced goes, and an installed one is extraneous.
  linkEdges('', rootEdges);
  const reached = new Set<string>();
  const pending = (edgesOut.get('') ?? []).map(({ to }) => to);
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (reached.has(at)) continue;
    reached.add(at);
    const node = nodes.get(at);
    if (!node) continue;
    linkEdges(at, manifestEdges(node.pkg, at));
    for (const { to } of edgesOut.get(at) ?? []) if (!reached.has(to)) pending.push(to);
  }
  const extraneous = new Set(candidates.keys());
  for (const [at, node] of [...nodes]) {
    if (reached.has(at)) continue;
    nodes.delete(at);
    if (!node.planned) extraneous.add(at);
  }
  for (const askers of failedAskers.values()) for (const asker of askers) if (asker.from === '' || nodes.has(asker.from)) link(asker);
  for (const id of [...failures.keys()]) if (!edgesIn.has(id)) failures.delete(id);

  // Required: reached by a path of required edges (calc-dep-flags).
  const required = new Set<string>();
  const unflagged = (edgesOut.get('') ?? []).filter(({ optional }) => !optional).map(({ to }) => to);
  for (let at = unflagged.pop(); at !== undefined; at = unflagged.pop()) {
    if (required.has(at)) continue;
    required.add(at);
    for (const { to, optional } of edgesOut.get(at) ?? []) if (!optional && !required.has(to)) unflagged.push(to);
  }

  // optional-set.js: from `id` up its required edges in, to the
  // optionalDependencies edges into the set; then gather-dep-set.js: with
  // what the set needs that nothing outside it needs.
  const optionalSet = (id: string): Set<string> => {
    const set = new Set([id]);
    for (const member of set) for (const { from, optional } of edgesIn.get(member) ?? []) if (!optional && from !== '') set.add(from);
    const deps = new Set(set);
    for (const member of deps) for (const { to, optional } of edgesOut.get(member) ?? []) if (!optional) deps.add(to);
    for (let changed = true; changed && deps.size > 0;) {
      changed = false;
      for (const dep of deps) {
        if (set.has(dep) || !(edgesIn.get(dep) ?? []).some(({ from, optional }) => !optional && !deps.has(from))) continue;
        deps.delete(dep);
        changed = true;
      }
    }
    return deps;
  };
  const skipped = new Set<string>();
  const reasons = new Map<string, string>();
  const leaveOut = (id: string, reason: string): ReadonlySet<string> | null => {
    if (required.has(id)) return null;
    reasons.set(id, reason);
    for (const member of optionalSet(id)) skipped.add(member);
    return skipped;
  };
  for (const failure of failures.values()) leaveOut(failure.id, failure.reason);
  for (const [at, reason] of whenOptional) if (nodes.has(at)) leaveOut(at, reason);

  return {
    nodes,
    failures: [...failures.values()],
    required,
    skipped,
    reasons,
    extraneous,
    fail: leaveOut,
  };
}

// ── One install into a tree at a time ────────────────────────────────────────

/**
 * Installs into one node_modules tree, one at a time, in the order they
 * asked. Keyed by the tree's namespace (a workspace's kernel, a session's
 * store) and its canonical path there, so two paths to one tree (a prefix
 * through a symlink) are one queue. A held tree's entry lists who waits for
 * it next.
 */
const heldTrees = new WeakMap<object, Map<string, Array<() => void>>>();

/**
 * Hold the tree at `canonical` in `namespace` for one install, and give it
 * back with the release this answers, once the install is done: at once
 * when no install holds it, else (a promise) once those before have given it
 * back. One that `signal` stops while it waits never holds it (an AbortError).
 */
export function holdTree(namespace: object, canonical: string, signal?: AbortSignal): (() => void) | Promise<() => void> {
  const held = heldTrees.get(namespace) ?? new Map<string, Array<() => void>>();
  if (held.size === 0) heldTrees.set(namespace, held);
  const release = () => {
    const next = held.get(canonical)?.shift();
    if (next === undefined) held.delete(canonical);
    else next();
  };
  const waiting = held.get(canonical);
  if (waiting === undefined) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    held.set(canonical, []);
    return release;
  }
  return new Promise<() => void>((resolve, reject) => {
    const admit = () => {
      signal?.removeEventListener('abort', abandon);
      resolve(release);
    };
    const abandon = () => {
      const at = waiting.indexOf(admit);
      if (at >= 0) waiting.splice(at, 1);
      reject(signal?.reason);
    };
    if (signal?.aborted) return abandon();
    signal?.addEventListener('abort', abandon, { once: true });
    waiting.push(admit);
  });
}

/**
 * Where `path` is: its deepest existing ancestor resolved through symlinks
 * (`realpath`), and the rest of it, which does not exist yet.
 */
export async function canonicalTreePath(realpath: (path: string) => Promise<string>, path: string): Promise<string> {
  let existing = path;
  let rest = '';
  while (existing !== '/' && existing !== '') {
    try {
      return (await realpath(existing)).replace(/\/+$/, '') + rest;
    } catch {
      const slash = existing.lastIndexOf('/');
      rest = existing.slice(slash) + rest;
      existing = slash > 0 ? existing.slice(0, slash) : '/';
    }
  }
  return rest || '/';
}
