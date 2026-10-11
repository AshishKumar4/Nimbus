/**
 * npm-tree.ts — the vocabulary of npm's one install engine, shared by the
 * engine (npm-arborist.ts, which builds the tree) and its two hosts (worker
 * npm/installer.ts and lifo commands/system/npm.ts): placements, manifests
 * and their edges, a project's roots, what the command line names and how it
 * is saved, and one install into a tree at a time.
 *
 * Placements are paths relative to the project's node_modules: `react` at
 * root, `pkg/node_modules/dep` nested. Node walks node_modules upward from
 * the importer, so a nested copy is found by its dependent and what is
 * beneath it, and by nobody else.
 */

import { isExactVersion, isSemverRange, rangeSubset, satisfiesRange } from './npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from './npm-spec.js';
import { LruMap } from './lru-map.js';
import { z } from 'zod/v4';

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

/**
 * A cycle with mutually incompatible ranges has no finite layout without
 * links: a request that would nest deeper than this fails rather than
 * nesting without end.
 */
export const MAX_NEST_DEPTH = 16;

// ── Manifests and edges ──────────────────────────────────────────────────────

/** A name → range map. */
export type DependencyMap = Readonly<Record<string, string>>;

/** The fields of a manifest its edges are read from. */
export interface TreeManifest {
  readonly dependencies?: DependencyMap;
  readonly optionalDependencies?: DependencyMap;
  readonly peerDependencies?: DependencyMap;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

/** A package a host knows: its name and version, and the manifest its edges are read from. */
export interface TreePackage extends TreeManifest {
  /** The name it is installed under (an alias's). */
  readonly name: string;
  readonly version: string;
  /** The registry package it is, where the host knows it (an alias's target): only that package meets an edge naming another. */
  readonly registryName?: string;
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
export function isPeer(type: EdgeType): boolean {
  return type === 'peer' || type === 'peerOptional';
}

/** An optional edge: its failure is no failure of the package that asks for it. */
export function isOptional(type: EdgeType): boolean {
  return type === 'optional' || type === 'peerOptional';
}

/**
 * The edges a manifest asks for, as npm's Node loads them (_loadDeps), the
 * later replacing the earlier of one name: its peers (an optional one is
 * peerOptional: not installed where absent, and constraining where present),
 * then its dependencies, then its optional dependencies. `legacyPeerDeps`:
 * peers are not loaded at all.
 */
export function manifestEdges(manifest: TreeManifest, { legacyPeerDeps = false } = {}): Array<Pick<TreeEdge, 'name' | 'range' | 'type'>> {
  const byName = new Map<string, Pick<TreeEdge, 'name' | 'range' | 'type'>>();
  if (!legacyPeerDeps) {
    const meta = manifest.peerDependenciesMeta ?? {};
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      byName.set(name, { name, range, type: meta[name]?.optional === true ? 'peerOptional' : 'peer' });
    }
  }
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) byName.set(name, { name, range, type: 'prod' });
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) byName.set(name, { name, range, type: 'optional' });
  return [...byName.values()];
}

/** What an edge's spec asks for: the registry package (an `npm:` alias's target), and its semver range, or null for a spec that is not one (a tag, `*`, a URL). */
export interface EdgeRequest {
  readonly registryName: string;
  readonly range: string | null;
}

/** Each spec parsed once, by `name\0spec`. */
const edgeRequests = new LruMap<string, EdgeRequest>(4096);

export function edgeRequest(name: string, spec: string): EdgeRequest {
  const key = `${name}\0${spec}`;
  let request = edgeRequests.get(key);
  if (request === undefined) {
    const { registryName, range } = parseRegistryRequest(name, spec);
    request = { registryName, range: isSemverRange(range) && range !== '*' && range !== '' ? range : null };
    edgeRequests.set(key, request);
  }
  return request;
}

/** Whether `version` meets an edge's range, as npm's dep-valid reckons it: any version, for a spec that is not a range. */
export function meets(version: string, edge: Pick<TreeEdge, 'name' | 'range'>): boolean {
  const { range } = edgeRequest(edge.name, edge.range);
  return range === null || satisfiesRange(version, range);
}

// ── The project's manifest ───────────────────────────────────────────────────

/** The project's package.json, as its roots and saves read it. */
export interface ProjectManifest extends TreeManifest {
  readonly devDependencies?: DependencyMap;
}

/** A dependency field as npm reads it: its string ranges (an entry of another shape names no dependency). */
const DependencyMapSchema = z.record(z.string(), z.unknown()).transform((map): Record<string, string> =>
  Object.fromEntries(Object.entries(map).flatMap(([name, range]) => (typeof range === 'string' ? [[name, range]] : []))));

const ProjectManifestSchema = z.object({
  dependencies: DependencyMapSchema.optional().catch(undefined),
  devDependencies: DependencyMapSchema.optional().catch(undefined),
  optionalDependencies: DependencyMapSchema.optional().catch(undefined),
  peerDependencies: DependencyMapSchema.optional().catch(undefined),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional().catch(undefined) }).catch({})).optional().catch(undefined),
});

/** package.json, read: the document as written (every field, for saving), and the dependencies npm reads from it. */
export interface PackageJsonDocument {
  readonly json: Readonly<Record<string, unknown>>;
  readonly manifest: ProjectManifest;
}

const PackageJsonSchema = z.record(z.string(), z.unknown());

/** A parsed package.json; null where it is not an object. */
export function packageJsonDocument(value: unknown): PackageJsonDocument | null {
  const json = PackageJsonSchema.safeParse(value);
  if (!json.success || Array.isArray(value)) return null;
  return { json: json.data, manifest: ProjectManifestSchema.parse(json.data) };
}

/** package.json's text, read; null where it is not JSON, or not an object. */
export function readPackageJson(text: string): PackageJsonDocument | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return packageJsonDocument(value);
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
type DependencyField = typeof DEPENDENCY_FIELDS[number];

// ── Roots ────────────────────────────────────────────────────────────────────

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

const SAVE_FIELD: Readonly<Record<SaveType, DependencyField>> = {
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
 * A project's roots, as npm's Node loads the root's edges, the later
 * replacing the earlier of one name: its peers, dependencies and optional
 * dependencies (manifestEdges), then its devDependencies; then the packages
 * named on the command line, explicit requests of their save type.
 * `implicit`: names the project needs without declaring them (a global
 * prefix's installed packages), each met by what is there.
 */
export function projectRoots(
  manifest: ProjectManifest | null,
  named: readonly NamedPackage[],
  { implicit = [], legacyPeerDeps = false }: { implicit?: readonly string[]; legacyPeerDeps?: boolean } = {},
): TreeRoot[] {
  const roots = new Map<string, TreeRoot>();
  for (const name of implicit) roots.set(name, { name, range: '*', type: 'prod' });
  for (const edge of manifestEdges(manifest ?? {}, { legacyPeerDeps })) roots.set(edge.name, edge);
  for (const [name, range] of Object.entries(manifest?.devDependencies ?? {})) roots.set(name, { name, range, type: 'dev' });
  for (const { name, range, saveType } of named) roots.set(name, { name, range: range ?? 'latest', type: saveType, explicit: true });
  return [...roots.values()];
}

/**
 * package.json (`json`, as parsed) with what the command line named saved,
 * as npm saves it after an install: each package that installed
 * (`installed`: the version under its name) under its save type, at
 * `^version` unless the spec given is a range `^version` would widen, an
 * alias as the package it names; out of the fields its save type excludes.
 * One that did not install keeps the spec given. As npm writes package.json,
 * a name in optionalDependencies is not repeated in dependencies. Every
 * other field is as it was.
 */
export function saveNamed(
  json: Readonly<Record<string, unknown>>,
  named: readonly NamedPackage[],
  installed: (name: string) => string | null,
): Record<string, unknown> {
  const declared = ProjectManifestSchema.parse(json);
  const fields = new Map<DependencyField, Record<string, string>>();
  const field = (key: DependencyField): Record<string, string> => {
    let map = fields.get(key);
    if (map === undefined) {
      map = { ...declared[key] };
      fields.set(key, map);
    }
    return map;
  };
  for (const { name, range, saveType } of named) {
    const drop = saveType === 'prod' ? ['devDependencies', 'peerDependencies'] as const
      : saveType === 'dev' ? ['dependencies'] as const
      : saveType === 'optional' ? ['peerDependencies'] as const
      : ['dependencies', 'optionalDependencies'] as const;
    for (const key of drop) if (declared[key]?.[name] !== undefined) delete field(key)[name];
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
    const target = field(SAVE_FIELD[saveType]);
    if (saved !== '*' || target[name] === undefined) target[name] = saved;
  }
  const optional = fields.get('optionalDependencies') ?? declared.optionalDependencies ?? {};
  for (const name of Object.keys(optional)) if ((fields.get('dependencies') ?? declared.dependencies)?.[name] !== undefined) delete field('dependencies')[name];
  return { ...json, ...Object.fromEntries(fields) };
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
