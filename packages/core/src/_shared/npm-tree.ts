/**
 * npm-tree.ts — the plan of npm's one install engine: the tree a set of
 * roots needs, built as npm's arborist builds it, from what a host answers.
 * Both hosts install through it: the worker's (worker npm/installer.ts:
 * resolver facets a layer at a time, the lockfile for what is installed) and
 * the shell's own (lifo commands/system/npm-install.ts: the registry one
 * package at a time, node_modules for what is installed).
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

import { MAX_NEST_DEPTH, decidePlacement, nestedPlacement, visiblePlacements, type PlacementEdge } from './npm-placement.js';

/** An edge of the tree: optional when it is an optionalDependencies entry (or an optional root). */
export type TreeEdge = PlacementEdge & { readonly optional: boolean };

/** The fields of a manifest its edges are read from. */
export interface TreeManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean } | undefined>>;
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
export function manifestEdges(manifest: TreeManifest, from: string): TreeEdge[] {
  const byName = new Map<string, TreeEdge>();
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) byName.set(name, { name, range, from, kind: 'dep', optional: false });
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) byName.set(name, { name, range, from, kind: 'dep', optional: true });
  const edges = [...byName.values()];
  const optionalPeers = manifest.peerDependenciesMeta ?? {};
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (optionalPeers[name]?.optional !== true && !byName.has(name)) edges.push({ name, range, from, kind: 'peer', optional: false });
  }
  return edges;
}

/** What a host answers for an edge it resolves. */
export type TreeResolution<P extends TreePackage> =
  /**
   * The package for the edge; one of another name (the host swapped it) is
   * placed under that name. With `skipIfOptional`, the host leaves it out
   * when it turns out optional (a native binding it cannot run), saying why.
   */
  | { readonly package: P; readonly skipIfOptional?: string }
  /** Not resolved: no such package or version, or the registry failed. */
  | { readonly failed: string }
  /** Refused by the host (a platform it cannot run): a failure, which an optional placement skips. */
  | { readonly refused: string }
  /** Left out by the host on purpose (a package it provides itself): no failure, and nothing placed. */
  | { readonly omitted: string };

/** What the plan is built from. */
export interface TreeHost<P extends TreePackage> {
  /** Resolve a layer of edges, together; an answer per edge, in order. */
  resolve(edges: readonly TreeEdge[]): Promise<ReadonlyArray<TreeResolution<P>>>;
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
  readonly planned: ReadonlyArray<{ readonly edge: TreeEdge; readonly at: string; readonly pkg: P }>;
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
export function projectRoots(
  manifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
  } | null,
  named: ReadonlyArray<{ readonly name: string; readonly range: string | null }>,
  { production = false }: { production?: boolean } = {},
): TreeRoot[] {
  const roots = new Map<string, TreeRoot>();
  for (const [name, range] of Object.entries(manifest?.dependencies ?? {})) roots.set(name, { name, range });
  if (!production) {
    for (const [name, range] of Object.entries(manifest?.devDependencies ?? {})) if (!roots.has(name)) roots.set(name, { name, range });
  }
  for (const [name, range] of Object.entries(manifest?.optionalDependencies ?? {})) roots.set(name, { name, range, optional: true });
  for (const { name, range } of named) roots.set(name, { name, range: range ?? '' });
  return [...roots.values()];
}

/** Plan the tree `roots` need, from what `host` answers. */
export async function planTree<P extends TreePackage>(roots: readonly TreeRoot[], host: TreeHost<P>): Promise<TreePlan<P>> {
  // Placements installed (as probed) and planned, with their packages.
  const placed = new Map<string, P>();
  const kept = new Map<string, P>();
  const pending = new Set<string>();
  const probed = new Set<string>();
  // Placements decided (planned or failed), and those whose edges are walked.
  const settled = new Set<string>();
  const walked = new Set<string>();
  const planned: Array<{ edge: TreeEdge; at: string; pkg: P }> = [];
  const failures: TreeFailure[] = [];
  const whenOptional = new Map<string, string>();
  // Who asks for each placement, and by which kind of edge.
  const askers = new Map<string, Array<{ from: string; optional: boolean }>>();
  const asked = (at: string, edge: TreeEdge) => {
    const list = askers.get(at) ?? [];
    askers.set(at, list);
    list.push({ from: edge.from, optional: edge.optional });
  };

  let queue: TreeEdge[] = roots.map(({ name, range, optional }) => ({ name, range, from: '', kind: 'dep', optional: optional === true }));
  while (queue.length > 0) {
    // What is installed where these edges look, read once.
    const unprobed = [...new Set(queue.flatMap((edge) => visiblePlacements(edge.from, edge.name)))]
      .filter((at) => !probed.has(at) && !placed.has(at) && !pending.has(at));
    for (const at of unprobed) probed.add(at);
    if (unprobed.length > 0) {
      const found = await host.installed(unprobed);
      unprobed.forEach((at, i) => {
        const pkg = found[i];
        if (pkg) { placed.set(at, pkg); kept.set(at, pkg); }
      });
    }

    const layer: Array<{ edge: TreeEdge; at: string }> = [];
    const next: TreeEdge[] = [];
    for (const edge of queue) {
      const decision = decidePlacement(edge, placed, pending);
      if (decision.kind === 'wait') { next.push(edge); continue; }
      if (decision.kind === 'met') {
        if (decision.mismatch) await host.peerMismatch?.(edge, decision.at, placed.get(decision.at)!.version);
        asked(decision.at, edge);
        // A kept package: its edges are the tree's too.
        const keptPkg = kept.get(decision.at);
        if (keptPkg && !walked.has(decision.at)) {
          walked.add(decision.at);
          next.push(...manifestEdges(keptPkg, decision.at));
        }
        continue;
      }
      asked(decision.at, edge);
      if (settled.has(decision.at)) continue;
      if (decision.kind === 'too-deep') {
        settled.add(decision.at);
        failures.push({ edge, at: decision.at, refused: false, reason: `${edge.name}@${edge.range} from ${edge.from} would nest deeper than ${MAX_NEST_DEPTH} levels (cycle with incompatible ranges)` });
        continue;
      }
      pending.add(decision.at);
      layer.push({ edge, at: decision.at });
    }
    queue = next;
    if (layer.length === 0) continue;

    const answers = await host.resolve(layer.map(({ edge }) => edge));
    layer.forEach(({ edge, at }, i) => {
      pending.delete(at);
      settled.add(at);
      const answer = answers[i];
      if (answer === undefined) {
        failures.push({ edge, at, refused: false, reason: 'the resolver returned no answer' });
      } else if ('failed' in answer) {
        failures.push({ edge, at, refused: false, reason: answer.failed });
      } else if ('refused' in answer) {
        failures.push({ edge, at, refused: true, reason: answer.refused });
      } else if ('package' in answer) {
        const { package: pkg } = answer;
        // A swap answers with another name: the package goes where that name would.
        const actual = pkg.name === edge.name ? at : at === edge.name ? pkg.name : nestedPlacement(edge.from, pkg.name);
        if (actual !== at) {
          asked(actual, edge);
          if (placed.has(actual)) return;
          settled.add(actual);
        }
        // What was installed here is replaced: its manifest is not the tree's.
        kept.delete(actual);
        placed.set(actual, pkg);
        walked.add(actual);
        planned.push({ edge, at: actual, pkg });
        if (answer.skipIfOptional !== undefined) whenOptional.set(actual, answer.skipIfOptional);
        queue.push(...manifestEdges(pkg, actual));
      }
    });
  }

  // Required: reached from a root by a path of required edges, through
  // planned and kept packages alike; the rest is optional.
  const required = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [at, list] of askers) {
      if (!required.has(at) && list.some(({ from, optional }) => !optional && (from === '' || required.has(from)))) {
        required.add(at);
        grew = true;
      }
    }
  }
  // What a skipped placement takes with it: what needs it by a required
  // edge (optional too, or it would have been required), and what only
  // skipped placements ask for.
  const skipped = new Set<string>();
  const reasons = new Map<string, string>();
  const skip = (at: string, reason: string) => {
    reasons.set(at, reason);
    const queued = [at];
    while (queued.length > 0) {
      const member = queued.pop()!;
      if (skipped.has(member)) continue;
      skipped.add(member);
      for (const { from, optional } of askers.get(member) ?? []) if (!optional && from !== '' && askers.has(from)) queued.push(from);
      for (const [other, list] of askers) {
        if (!skipped.has(other) && !required.has(other) && list.every(({ from }) => skipped.has(from))) queued.push(other);
      }
    }
  };
  for (const { at, reason } of failures) if (!required.has(at)) skip(at, reason);
  for (const [at, reason] of whenOptional) if (!required.has(at)) skip(at, reason);

  return {
    planned, kept, failures, required, skipped, reasons,
    skip: (at, reason) => {
      if (required.has(at)) return false;
      skip(at, reason);
      return true;
    },
  };
}

/** The required placements of `plan` that could not be filled: any fails the install. */
export function requiredFailures(plan: Pick<TreePlan<TreePackage>, 'failures' | 'required'>): TreeFailure[] {
  return plan.failures.filter(({ at }) => plan.required.has(at));
}

/**
 * Installs into one node_modules tree, one at a time: each waits for the one
 * before it. Keyed by the tree's namespace (a workspace's kernel, a session's
 * store) and its canonical path there (`canonical`), so two paths to one tree
 * (a prefix through a symlink) are one queue.
 */
const installQueues = new WeakMap<object, Map<string, Promise<unknown>>>();

/** `run` once no other install into the tree at `canonical` in `namespace` is running. */
export async function withTreeLock<T>(namespace: object, canonical: string, run: () => Promise<T>): Promise<T> {
  const queues = installQueues.get(namespace) ?? new Map<string, Promise<unknown>>();
  installQueues.set(namespace, queues);
  const before = queues.get(canonical) ?? Promise.resolve();
  const done = before.then(run, run);
  const settled = done.then(() => undefined, () => undefined);
  queues.set(canonical, settled);
  try {
    return await done;
  } finally {
    if (queues.get(canonical) === settled) queues.delete(canonical);
  }
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
