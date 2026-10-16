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

import { depthOf, parentPlacement, placementName, type TreeEdge, type TreePackage, type TreeRoot } from '../npm-tree.js';
import { Builder } from './build.js';
import { calcDepFlags } from './flags.js';
import { descendants, Node, Tree } from './model.js';
import { PeerConflict } from './place-dep.js';
import { optionalSet } from './sets.js';

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
  | ({ readonly package: P } & HostVerdicts)
  /** Not resolved: no such package or version, or the registry failed. */
  | { readonly failed: string };

/**
 * A package installed before this install, at its placement, with the
 * host's verdicts on it (`lock`, the flags a lock records for it); or a
 * placement whose package the host cannot install at all, with why.
 */
export type InstalledPackage<I extends TreePackage> =
  | ({ readonly at: string; readonly pkg: I; readonly lock?: LockFlags } & HostVerdicts)
  | { readonly at: string; readonly failed: string };

/** What the plan is built from: `P`, the packages it resolves. */
export interface TreeHost<P extends TreePackage> {
  /** Resolve requests together; an answer per request, in order. */
  resolve(requests: ReadonlyArray<{ readonly name: string; readonly range: string }>): Promise<ReadonlyArray<TreeResolution<P>>>;
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
export type TreeNode<P extends TreePackage, I extends TreePackage> =
  | { readonly at: string; readonly planned: true; readonly pkg: P; readonly edge: TreeEdge }
  | { readonly at: string; readonly planned: false; readonly pkg: I };

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
export function requiredFailures(plan: Pick<TreePlan<TreePackage, TreePackage>, 'failures' | 'required'>): TreeFailure[] {
  return plan.failures.filter(({ id }) => plan.required.has(id));
}

/** Plan the tree `roots` need over what is `installed`, from what `host` answers. */
export async function planTree<P extends TreePackage, I extends TreePackage>(
  roots: readonly TreeRoot[],
  installed: ReadonlyArray<InstalledPackage<I>>,
  host: TreeHost<P>,
  options: PlanOptions = {},
): Promise<TreePlan<P, I>> {
  type H = { readonly resolved: P; readonly installed: I };
  const project = new Node<H>('', { kind: 'project' }, roots.map(({ name, range, type, explicit }) => ({ name, range, type, explicit })));
  const tree = new Tree<H>(project, options.global === true);
  const builder = new Builder<H>(tree, host, options);

  // The installed tree, each package in its folder.
  const installedAt = new Map<string, Node<H>>([['', project]]);
  for (const entry of [...installed].sort((a, b) => depthOf(a.at) - depthOf(b.at))) {
    const parent = installedAt.get(parentPlacement(entry.at));
    if (!parent) continue;
    const name = placementName(entry.at);
    const node = 'failed' in entry
      ? new Node<H>(name, { kind: 'failed', reason: entry.failed }, [])
      : new Node<H>(name, { kind: 'installed', pkg: entry.pkg, refused: entry.refused, skipIfOptional: entry.skipIfOptional, lock: entry.lock }, builder.edgesOf(entry.pkg));
    tree.attach(node, parent);
    installedAt.set(entry.at, node);
    if (node.failed !== undefined) builder.loadFailures.add(node);
  }

  const failures = new Map<string, TreeFailure>();
  try {
    await builder.build();
  } catch (error) {
    if (!(error instanceof PeerConflict)) throw error;
    failures.set('!ERESOLVE', { edge: error.edge, reason: error.message, refused: false, id: '!ERESOLVE' });
  }
  for (const message of builder.placer.warnings) await host.warn?.(message);

  // npm ci: every package the build placed is one the lock lacks, or holds at another version.
  const lockMismatches: string[] = [];
  if (options.locked) {
    for (const each of tree.nodes()) {
      if (each.payload.kind !== 'placed') continue;
      const locked = installedAt.get(each.location)?.pkg;
      if (!locked) lockMismatches.push(`Missing: ${each.name}@${each.version} from lock file`);
      else if (locked.version !== each.version) lockMismatches.push(`Invalid: lock file's ${each.name}@${locked.version} does not satisfy ${each.name}@${each.version}`);
    }
  }

  // ── calc-dep-flags; a lock's own flags where the build changed nothing (npm ci) ──
  const { reached, required, prod, prodRequired, nonPeer } = calcDepFlags(project);
  const lockFlags = options.locked === 'trusted' && !builder.mutated;
  const lockOf = (each: Node<H>) => (each.payload.kind === 'installed' && lockFlags ? each.payload.lock : undefined);
  const flagsOf = (each: Node<H>): LockFlags =>
    lockOf(each) ?? { dev: !prod.has(each), optional: !required.has(each), devOptional: !prodRequired.has(each), peer: !nonPeer.has(each) };
  // A failure is fatal unless the package is optional (reify's _handleOptionalFailure): devOptional only joins the --omit filter.
  const isRequired = (each: Node<H>) => {
    const lock = lockOf(each);
    return lock ? lock.optional !== true : required.has(each);
  };

  // What the project does not reach is extraneous: it goes from a tree
  // installed before, but a lock's tree npm ci installs as it is.
  if (installed.length > 0 && !lockFlags) for (const each of [...tree.nodes()]) if (each.tree === tree && !reached.has(each)) tree.detach(each);
  const extraneous = new Set<string>();
  for (const [at, each] of installedAt) if (at !== '' && each.tree !== tree) extraneous.add(at);

  // The tree, as the hosts get it, before anything is left out of it, in npm's inventory order.
  const nodes = new Map<string, TreeNode<P, I>>();
  const requiredAt = new Set<string>();
  const flagsAt = new Map<string, LockFlags>();
  for (const each of tree.inventory) {
    if (each === project) continue;
    const at = each.location;
    if (isRequired(each)) requiredAt.add(at);
    flagsAt.set(at, flagsOf(each));
    const { payload } = each;
    if (payload.kind === 'placed') nodes.set(at, { at, planned: true, pkg: payload.pkg, edge: payload.placedFor });
    else if (payload.kind === 'installed') nodes.set(at, { at, planned: false, pkg: payload.pkg });
  }

  // ── A package that failed to load, or is refused: a required one fails the install, an optional one goes with its optional set ──
  const skipped = new Set<string>();
  const reasons = new Map<string, string>();
  const leaveOut = (start: Node<H>, reason: string): ReadonlySet<string> | null => {
    if (isRequired(start)) return null;
    reasons.set(start.location, reason);
    // The set, and what is beneath each member's folder, which goes with it.
    const set = optionalSet(start);
    for (const member of set) for (const each of [member, ...descendants(member)]) skipped.add(each.location);
    for (const member of set) tree.detach(member);
    return skipped;
  };
  const failure = (each: Node<H>, reason: string, refused: boolean) => {
    const id = each.location;
    const { payload } = each;
    const placedFor = payload.kind === 'placed' || payload.kind === 'failed' ? payload.placedFor : undefined;
    failures.set(id, {
      edge: placedFor ?? { name: each.name, range: '*', from: each.parent?.location ?? '', type: 'prod', explicit: false },
      reason, refused, id,
    });
    if (isRequired(each)) requiredAt.add(id);
    else leaveOut(each, reason);
  };
  for (const each of [...builder.loadFailures]) if (each.tree === tree && each.failed !== undefined) failure(each, each.failed, false);
  for (const each of [...tree.nodes()]) {
    const { refused } = each.verdicts;
    if (each.tree === tree && refused !== undefined) failure(each, refused, true);
  }
  for (const each of [...tree.nodes()]) {
    const { skipIfOptional } = each.verdicts;
    if (each.tree === tree && skipIfOptional !== undefined && !isRequired(each)) leaveOut(each, skipIfOptional);
  }
  if (failures.has('!ERESOLVE')) requiredAt.add('!ERESOLVE');

  const byPlacement = new Map([...tree.nodes()].map((each) => [each.location, each]));
  return {
    nodes,
    resolvedAny: builder.resolutions.size > 0,
    failures: [...failures.values()],
    lockMismatches,
    required: requiredAt,
    omits: (at, omit) => {
      const flags = flagsAt.get(at);
      // Under a global prefix every node's top is a top-level package, not the project: nothing is omitted (reify's trash list).
      if (!flags || options.global) return false;
      return (omit.dev === true && flags.dev === true) || (omit.optional === true && flags.optional === true)
        || (omit.dev === true && omit.optional === true && flags.devOptional === true) || (omit.peer === true && flags.peer === true);
    },
    skipped,
    reasons,
    extraneous,
    fail: (at, reason) => {
      const each = byPlacement.get(at);
      if (!each || each.tree !== tree) return skipped.has(at) ? skipped : null;
      return leaveOut(each, reason);
    },
  };
}
