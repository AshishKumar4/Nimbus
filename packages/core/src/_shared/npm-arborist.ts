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

import { versionAtLeast } from './npm-semver.js';
import {
  bundledNames, depthOf, edgeRequest, isOptional, isPeer, manifestEdges, MAX_NEST_DEPTH, meets,
  type EdgeType, type TreeEdge, type TreePackage, type TreeRoot,
} from './npm-tree.js';

// ── What a host gives and is given ───────────────────────────────────────────

/** What a host answers for a request it resolves. */
export type TreeResolution<P extends TreePackage> =
  /**
   * The package for the request (under the requested name). `refused`: the
   * host cannot install it (a platform it cannot run), which fails a
   * required placement and leaves an optional one out; `skipIfOptional`: it
   * installs where required, and is left out where optional.
   */
  | { readonly package: P; readonly refused?: string; readonly skipIfOptional?: string }
  /** Not resolved: no such package or version, or the registry failed. */
  | { readonly failed: string };

/**
 * A package installed before this install, at its placement (`refused` and
 * `skipIfOptional` as a resolution's); or, in a frozen tree, a placement the
 * host cannot install at all, with why.
 */
export type InstalledPackage<I extends TreePackage> =
  | { readonly at: string; readonly pkg: I; readonly refused?: string; readonly skipIfOptional?: string }
  | { readonly at: string; readonly failed: string };

/** What the plan is built from: `P`, the packages it resolves. */
export interface TreeHost<P extends TreePackage> {
  /** Resolve requests together; an answer per request, in order. */
  resolve(requests: ReadonlyArray<{ readonly name: string; readonly range: string }>): Promise<ReadonlyArray<TreeResolution<P>>>;
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
export type TreeNode<P extends TreePackage, I extends TreePackage> =
  | { readonly at: string; readonly planned: true; readonly pkg: P; readonly edge: TreeEdge }
  | { readonly at: string; readonly planned: false; readonly pkg: I };

export interface TreePlan<P extends TreePackage, I extends TreePackage> {
  /** The tree, by placement: placed and kept packages alike, the skipped among them. */
  readonly nodes: ReadonlyMap<string, TreeNode<P, I>>;
  /** Whether the build asked the host to resolve anything. */
  readonly resolvedAny: boolean;
  readonly failures: readonly TreeFailure[];
  /** Placements (and failure ids) a path of required edges reaches from the project. */
  readonly required: ReadonlySet<string>;
  /** Placements only devDependencies reach (calc-dep-flags' dev): what `--omit=dev` leaves out at reification. */
  readonly dev: ReadonlySet<string>;
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

// ── The tree's model ─────────────────────────────────────────────────────────

/** npm's string order (@isaacs/string-locale-compare's 'en'), one collator for every comparison. */
const localeCompare = new Intl.Collator('en').compare;

type EdgeDefinition = Pick<TreeEdge, 'name' | 'range' | 'type'> & { readonly explicit?: boolean };

class Edge {
  /** The node Node's walk finds from `from`, kept current by its tree. */
  to: Node | null = null;
  peerConflicted = false;
  constructor(readonly from: Node, readonly name: string, readonly spec: string, readonly type: EdgeType, readonly explicit: boolean) {}
  get peer(): boolean { return isPeer(this.type); }
  get optional(): boolean { return isOptional(this.type); }
  /** Edge.valid: met, or an absent optional peer; never a peer inside its own dependent. */
  get valid(): boolean {
    if (this.to === null) return this.type === 'peerOptional';
    if (this.peer && this.to.parent === this.from && !this.from.isTop) return false;
    return this.to.satisfies(this);
  }
  get definition(): EdgeDefinition { return { name: this.name, range: this.spec, type: this.type, explicit: this.explicit }; }
  get public(): TreeEdge { return { name: this.name, range: this.spec, from: this.from.location, type: this.type, explicit: this.explicit }; }
}

interface NodeMarks {
  /** It failed to load: no package. */
  readonly failed?: string;
  /** The host refuses it. */
  readonly refused?: string;
  readonly skipIfOptional?: string;
  /** What placed it in the tree. */
  readonly placedFor?: TreeEdge;
  /** A virtual root's: the node whose edges it copies. */
  readonly sourceReference?: Node;
}

class Node {
  readonly children = new Map<string, Node>();
  readonly edgesOut = new Map<string, Edge>();
  readonly edgesIn = new Set<Edge>();
  parent: Node | null = null;
  /** The tree it is in; null once taken out. */
  tree: Tree | null = null;
  constructor(
    readonly name: string,
    /** Null for one that failed to load. */
    readonly pkg: TreePackage | null,
    readonly origin: 'project' | 'installed' | 'planned' | 'virtual',
    readonly marks: NodeMarks,
    edges: readonly EdgeDefinition[],
  ) {
    for (const { name: dep, range, type, explicit } of edges) this.edgesOut.set(dep, new Edge(this, dep, range, type, explicit === true));
  }
  get isProjectRoot(): boolean { return this.origin === 'project'; }
  get isTop(): boolean { return this.parent === null; }
  /** A top-level package of a global prefix. */
  get globalTop(): boolean { return this.tree?.global === true && this.parent?.isProjectRoot === true; }
  get version(): string | null { return this.pkg?.version ?? null; }
  get location(): string {
    if (this.parent === null) return '';
    const parent = this.parent.location;
    return parent ? `${parent}/node_modules/${this.name}` : this.name;
  }
  get depth(): number {
    let depth = 0;
    for (let up = this.parent; up; up = up.parent) depth++;
    return depth;
  }
  *ancestry(): Generator<Node> { for (let node: Node | null = this; node; node = node.parent) yield node; }
  isDescendantOf(ancestor: Node): boolean {
    for (const node of this.ancestry()) if (node === ancestor) return true;
    return false;
  }
  resolve(name: string): Node | null {
    for (const node of this.ancestry()) {
      const child = node.children.get(name);
      if (child) return child;
    }
    return null;
  }
  satisfies(edge: Pick<Edge, 'name' | 'spec'>): boolean {
    if (this.pkg === null || edge.name !== this.name) return false;
    const { registryName } = edgeRequest(edge.name, edge.spec);
    if (this.pkg.registryName !== undefined && this.pkg.registryName !== registryName) return false;
    return meets(this.pkg.version, { name: edge.name, range: edge.spec });
  }
  /** The same package at the same version. */
  matches(other: Node): boolean {
    if (this.pkg === null || other.pkg === null || this.name !== other.name || this.pkg.version !== other.pkg.version) return false;
    return this.pkg.registryName === undefined || other.pkg.registryName === undefined || this.pkg.registryName === other.pkg.registryName;
  }
}

/** One tree of nodes (the ideal tree, or a virtual root's), every edge's target kept current as nodes come and go. */
class Tree {
  private readonly edgesByName = new Map<string, Set<Edge>>();
  private readonly byName = new Map<string, Set<Node>>();
  constructor(readonly root: Node, readonly global: boolean) {
    this.register(root);
  }

  named(name: string): ReadonlySet<Node> { return this.byName.get(name) ?? new Set(); }

  /** Whether anything in the tree is, or asks for, `name`. */
  mentions(name: string): boolean { return (this.byName.get(name)?.size ?? 0) > 0 || (this.edgesByName.get(name)?.size ?? 0) > 0; }

  *nodes(): Generator<Node> {
    const pending = [...this.root.children.values()];
    for (let node = pending.pop(); node; node = pending.pop()) {
      yield node;
      pending.push(...node.children.values());
    }
  }

  /** Put `node` in `parent`'s node_modules, where what was there goes. */
  attach(node: Node, parent: Node): void {
    if (node.parent === parent && parent.children.get(node.name) === node) return;
    const old = parent.children.get(node.name);
    if (old) this.detach(old);
    if (node.parent) this.detach(node);
    node.parent = parent;
    parent.children.set(node.name, node);
    for (const each of [node, ...descendants(node)]) this.register(each);
    this.reload(node.name, parent);
  }

  /** Put `node` where `old` is: it takes what `old` holds (Node.replace). */
  replace(node: Node, old: Node): void {
    const parent = old.parent;
    if (parent === null) return;
    for (const kid of old.children.values()) {
      kid.parent = node;
      node.children.set(kid.name, kid);
    }
    old.children.clear();
    this.unregister(old);
    old.parent = null;
    node.parent = parent;
    parent.children.set(node.name, node);
    this.register(node);
    this.reload(node.name, parent);
  }

  /** Take `node`, and what is beneath it, out of the tree. */
  detach(node: Node): void {
    const parent = node.parent;
    if (parent === null || node.tree !== this) return;
    parent.children.delete(node.name);
    node.parent = null;
    for (const each of [node, ...descendants(node)]) this.unregister(each);
    this.reload(node.name, parent);
  }

  private register(node: Node): void {
    node.tree = this;
    if (node !== this.root) {
      let named = this.byName.get(node.name);
      if (!named) this.byName.set(node.name, named = new Set());
      named.add(node);
    }
    for (const edge of node.edgesOut.values()) {
      let edges = this.edgesByName.get(edge.name);
      if (!edges) this.edgesByName.set(edge.name, edges = new Set());
      edges.add(edge);
      this.retarget(edge);
    }
  }

  private unregister(node: Node): void {
    node.tree = null;
    this.byName.get(node.name)?.delete(node);
    for (const edge of node.edgesOut.values()) {
      this.edgesByName.get(edge.name)?.delete(edge);
      edge.to?.edgesIn.delete(edge);
      edge.to = null;
    }
  }

  /** Every edge for `name` from `parent` or beneath it, retargeted. */
  private reload(name: string, parent: Node): void {
    for (const edge of [...this.edgesByName.get(name) ?? []]) if (edge.from.isDescendantOf(parent)) this.retarget(edge);
  }

  private retarget(edge: Edge): void {
    const to = edge.from.resolve(edge.name);
    if (to === edge.to) return;
    edge.to?.edgesIn.delete(edge);
    edge.to = to;
    to?.edgesIn.add(edge);
  }
}

function* descendants(node: Node): Generator<Node> {
  const pending = [...node.children.values()];
  for (let each = pending.pop(); each; each = pending.pop()) {
    yield each;
    pending.push(...each.children.values());
  }
}

// ── Sets of nodes (gather-dep-set.js, optional-set.js, peer-entry-sets.js) ──

/** `set` with everything it depends on (through `follow`), less what anything outside the result depends on. */
function gatherDepSet(set: Iterable<Node>, follow: (edge: Edge) => boolean): Set<Node> {
  const deps = new Set(set);
  for (const node of deps) for (const edge of node.edgesOut.values()) if (edge.to && follow(edge)) deps.add(edge.to);
  for (let changed = true; changed && deps.size > 0;) {
    changed = false;
    for (const dep of deps) {
      for (const edge of dep.edgesIn) {
        if (!deps.has(edge.from) && follow(edge)) {
          changed = true;
          deps.delete(dep);
          break;
        }
      }
    }
  }
  return deps;
}

/** What goes with an optional `node` that fails: up to the optional edges into it, and what only that needs. */
function optionalSet(node: Node): Set<Node> {
  const set = new Set([node]);
  for (const member of set) for (const edge of member.edgesIn) if (!edge.optional) set.add(edge.from);
  return gatherDepSet(set, (edge) => !edge.optional);
}

/** The peer groups `node` is in, by the edge that enters each. */
function peerEntrySets(node: Node): Map<Edge, Set<Node>> {
  const union = new Set([node]);
  for (const member of union) {
    for (const edge of member.edgesOut.values()) if (edge.valid && edge.peer && edge.to) union.add(edge.to);
    for (const edge of member.edgesIn) if (edge.valid && edge.peer) union.add(edge.from);
  }
  const sets = new Map<Edge, Set<Node>>();
  for (const peer of union) {
    for (const edge of peer.edgesIn) {
      if (!edge.valid || (edge.peer && !edge.from.isTop)) continue;
      const sub = new Set([peer]);
      for (const member of sub) for (const out of member.edgesOut.values()) if (out.valid && out.peer && out.to) sub.add(out.to);
      if (sub.has(node)) sets.set(edge, sub);
    }
  }
  return sets;
}

/** The deepest place `name`, a dependency of `start`, may go: above every dependent that has it as a peer. */
function deepestNestingTarget(start: Node, name: string | undefined): Node {
  for (const target of start.ancestry()) {
    if (target.isProjectRoot || target.parent === null || target.globalTop) return target;
    const edge = name === undefined ? undefined : target.edgesOut.get(name);
    if (!edge || !edge.peer) return target;
  }
  return start;
}

/** Whether `node` may stand in for `old`: every edge into `old` from outside what only `old` needs accepts it (Node.canReplaceWith). */
function canReplace(node: Node, old: Node, ignorePeers: Iterable<string> = []): boolean {
  if (node.name !== old.name) return false;
  if (node.pkg?.registryName !== undefined && old.pkg?.registryName !== undefined && node.pkg.registryName !== old.pkg.registryName) return false;
  const ignored = new Set(ignorePeers);
  const depSet = gatherDepSet([old], (edge) => edge.to !== old && edge.valid);
  for (const edge of old.edgesIn) {
    if (!old.isTop && edge.from.parent === old.parent && edge.peer && ignored.has(edge.from.name)) continue;
    if (!depSet.has(edge.from) && !node.satisfies(edge)) return false;
  }
  return true;
}

/** Whether `node` came in a package's archive: a name its parent, or an ancestor between, bundles (Node.inDepBundle). */
function inBundle(node: Node): boolean {
  for (let child = node, parent = node.parent; parent && !parent.isProjectRoot; child = parent, parent = parent.parent) {
    if (parent.pkg !== null && bundledNames(parent.pkg).includes(child.name)) return true;
  }
  return false;
}

/** Whether `node` is a needless copy: nothing wants it, or a copy two folders up does as well; never a bundled one (Node.canDedupe). */
function canDedupe(node: Node, preferDedupe: boolean): boolean {
  if (inBundle(node)) return false;
  const grandparent = node.parent?.parent;
  if (!grandparent) return false;
  if (node.edgesIn.size === 0) return true;
  const other = grandparent.resolve(node.name);
  if (!other) return false;
  if (other.matches(node)) return true;
  if (!canReplace(other, node)) return false;
  return preferDedupe || (other.version !== null && node.version !== null && versionAtLeast(other.version, node.version));
}

// ── Placement (can-place-dep.js, place-dep.js) ───────────────────────────────

type Verdict = 'OK' | 'REPLACE' | 'KEEP' | 'CONFLICT';

/** Whether `dep` (a member of its virtual root's peer set) may go into `target`'s node_modules for `edge`, with its peers (CanPlaceDep). Reads the tree; never changes it. */
class CanPlace {
  readonly verdict: Verdict;
  self: Verdict | null = null;
  private readonly current: Node | undefined;
  private readonly targetEdge: Edge | undefined;
  private readonly edgeOverride: boolean;
  private readonly preferDedupe: boolean;
  private peersChecked: Verdict | null = null;

  constructor(
    readonly dep: Node,
    readonly target: Node,
    readonly edge: Edge,
    private readonly parent: CanPlace | null,
    private readonly peerPath: readonly Node[],
    preferDedupe: boolean,
    private readonly explicit: boolean,
  ) {
    this.preferDedupe = preferDedupe || edge.peer;
    this.current = target.children.get(edge.name);
    this.targetEdge = target.edgesOut.get(edge.name);
    this.edgeOverride = !dep.satisfies(edge);
    this.verdict = this.check();
    if (this.self === null) this.self = this.verdict;
  }

  get top(): CanPlace { return this.parent ? this.parent.top : this; }
  get deepest(): Node { return deepestNestingTarget(this.parent ? this.parent.deepest : this.edge.from, this.edge.name); }

  private check(): Verdict {
    const { target, targetEdge, current, dep, edge } = this;
    // A package that failed to load goes in the first place tried: the install fails, or it is pruned.
    if (dep.marks.failed !== undefined) return current ? 'REPLACE' : 'OK';
    if (targetEdge && targetEdge.peer && !target.isTop) return 'CONFLICT';
    if (!current && targetEdge && !dep.satisfies(targetEdge) && targetEdge !== edge) return 'CONFLICT';
    return current ? this.checkCurrent(current) : this.checkNoCurrent();
  }

  private checkCurrent(current: Node): Verdict {
    const { dep, edge, explicit, target, preferDedupe } = this;
    if (dep.matches(current) && (current.satisfies(edge) || this.edgeOverride)) return explicit ? 'REPLACE' : 'KEEP';
    const tryReplace = current.version !== null && dep.version !== null && versionAtLeast(dep.version, current.version);
    if (tryReplace && canReplace(dep, current)) {
      const peers = this.peers('REPLACE');
      if (peers !== 'CONFLICT') return peers;
    }
    if (current.satisfies(edge) && (!explicit || preferDedupe)) return 'KEEP';
    if (preferDedupe && !tryReplace && canReplace(dep, current)) {
      const peers = this.peers('REPLACE');
      if (peers !== 'CONFLICT') return peers;
    }
    if (target !== this.deepest) return 'CONFLICT';
    if (!edge.peer && target === edge.from) return this.peers('REPLACE');
    if (!this.parent && !edge.peer) return 'CONFLICT';
    // Each peer group the current copy is in must be replaceable by this
    // set, or able to nest deeper than here.
    const members = dep.parent?.children ?? new Map<string, Node>();
    let replaceable = true;
    for (const [entryEdge, currentPeers] of peerEntrySets(current)) {
      if (entryEdge === edge || entryEdge === this.top.edge) continue;
      const entryNode = entryEdge.to;
      if (!entryNode) continue;
      const entryRep = members.get(entryNode.name);
      if (entryRep && canReplace(entryRep, entryNode, members.keys())) continue;
      let clobber = !entryRep;
      if (!entryRep) {
        const walk = new Set([entryNode]);
        outer: for (const peer of walk) {
          for (const out of peer.edgesOut.values()) {
            if (!out.peer || !out.valid) continue;
            const rep = members.get(out.name);
            if (!rep) {
              if (out.to) walk.add(out.to);
              continue;
            }
            if (!rep.satisfies(out)) {
              clobber = false;
              break outer;
            }
          }
        }
      }
      if (clobber) continue;
      for (const currentPeer of currentPeers) {
        const curDeep = deepestNestingTarget(entryEdge.from, currentPeer.name);
        if (curDeep === target || target.isDescendantOf(curDeep)) {
          replaceable = false;
          break;
        }
      }
    }
    return replaceable ? this.peers('REPLACE') : 'CONFLICT';
  }

  private checkNoCurrent(): Verdict {
    const { target, dep, edge } = this;
    const current = target !== this.top.edge.from ? target.resolve(edge.name) : null;
    if (current) {
      for (const into of current.edgesIn) {
        if (into.from.isDescendantOf(target) && into.valid && !dep.satisfies(into)) return 'CONFLICT';
      }
    }
    return this.peers('OK');
  }

  /** Whether the peers of `dep` can go with it: `state`, or CONFLICT. */
  private peers(state: Verdict): Verdict {
    this.self = state;
    if (this.peersChecked !== null) return this.peersChecked;
    const peerPath = [...this.peerPath, this.dep];
    let conflict = false;
    for (const peerEdge of this.dep.edgesOut.values()) {
      const peer = peerEdge.to;
      if (!peerEdge.peer || !peer || peerPath.includes(peer)) continue;
      const check = new CanPlace(peer, deepestNestingTarget(this.target, peer.name), peerEdge, this, peerPath, true, false);
      if (check.verdict === 'CONFLICT') conflict = true;
    }
    this.peersChecked = conflict ? 'CONFLICT' : state;
    return this.peersChecked;
  }
}

/** One placement and what it entails (PlaceDep). */
interface Placement {
  readonly edge: Edge;
  /** The package placed, in its virtual root. */
  readonly dep: Node;
  readonly parent: Placement | null;
  /** Where it would start: above every dependent that has it as a peer. */
  readonly start: Node;
  readonly explicit: boolean;
  canPlace: CanPlace | null;
  canPlaceSelf: CanPlace | null;
  placed: Node | null;
  readonly children: Placement[];
  /** Nodes whose edges a pruned peer set left unmet. */
  readonly needEvaluation: Set<Node>;
}

const topOf = (placement: Placement): Placement => (placement.parent ? topOf(placement.parent) : placement);

class PeerConflict extends Error {
  constructor(readonly edge: TreeEdge, message: string) { super(message); }
}

// ── The build (build-ideal-tree.js) ──────────────────────────────────────────

class Builder<P extends TreePackage> {
  readonly loadFailures = new Set<Node>();
  readonly warnings: string[] = [];
  private queue: Node[] = [];
  private readonly queued = new Set<Node>();
  private queueSorted = true;
  /** Requests whose package's edges prefetch has asked for. */
  private readonly expanded = new Set<string>();
  private readonly seen = new Set<Node>();
  private readonly virtualRoots = new Map<Node, Node>();
  readonly resolutions = new Map<string, TreeResolution<P>>();

  constructor(readonly tree: Tree, private readonly host: TreeHost<P>, private readonly options: PlanOptions) {}

  /** A package's edges, read from its manifest once. */
  private readonly edgeDefinitions = new WeakMap<TreePackage, EdgeDefinition[]>();
  edgesOf(pkg: TreePackage | null): EdgeDefinition[] {
    if (pkg === null) return [];
    let edges = this.edgeDefinitions.get(pkg);
    if (edges === undefined) {
      edges = manifestEdges(pkg, { legacyPeerDeps: this.options.legacyPeerDeps === true });
      this.edgeDefinitions.set(pkg, edges);
    }
    return edges;
  }

  // ── The queue (DepsQueue): the shallowest first, then by placement ──

  private push(node: Node): void {
    if (this.queued.has(node)) return;
    this.queued.add(node);
    this.queueSorted = false;
    this.queue.push(node);
  }

  private pop(): Node | undefined {
    if (!this.queueSorted) {
      // Each node's place read once for the sort.
      const keyed = this.queue.map((node) => ({ node, depth: node.depth, location: node.location }));
      keyed.sort((a, b) => a.depth - b.depth || localeCompare(a.location, b.location));
      this.queue = keyed.map(({ node }) => node);
      this.queueSorted = true;
    }
    const node = this.queue.shift();
    if (node) this.queued.delete(node);
    return node;
  }

  // ── Resolution ──

  private requestKey(name: string, range: string): string { return `${name}\0${range}`; }

  /** Resolve every request not yet answered, together. */
  private async resolve(requests: ReadonlyArray<{ name: string; range: string }>): Promise<void> {
    const missing = [...new Map(requests.filter(({ name, range }) => !this.resolutions.has(this.requestKey(name, range)))
      .map((request) => [this.requestKey(request.name, request.range), request])).values()];
    if (missing.length === 0) return;
    const answers = await this.host.resolve(missing);
    missing.forEach(({ name, range }, i) => this.resolutions.set(this.requestKey(name, range), answers[i] ?? { failed: 'the resolver returned no answer' }));
  }

  /** The node `name@spec` resolves to, in `parent` (a virtual root): its package, or a load failure (#nodeFromSpec). */
  private async nodeFromSpec(name: string, spec: string, parent: Node): Promise<Node> {
    await this.resolve([{ name, range: spec }]);
    const answer = this.resolutions.get(this.requestKey(name, spec)) ?? { failed: 'the resolver returned no answer' };
    const node = 'failed' in answer
      ? new Node(name, null, 'virtual', { failed: answer.failed }, [])
      : new Node(name, answer.package, 'virtual', { refused: answer.refused, skipIfOptional: answer.skipIfOptional }, this.edgesOf(answer.package));
    if (node.marks.failed !== undefined) this.loadFailures.add(node);
    parent.tree?.attach(node, parent);
    return node;
  }

  /** A root outside the tree with `source`'s edges, where a package and its peer set are loaded (#virtualRoot). */
  private virtualRoot(source: Node, reuse: boolean): Node {
    const existing = reuse ? this.virtualRoots.get(source) : undefined;
    if (existing) return existing;
    const root = new Node('', source.pkg, 'virtual', { sourceReference: source }, [...source.edgesOut.values()].map((edge) => edge.definition));
    new Tree(root, false);
    this.virtualRoots.set(source, root);
    return root;
  }

  /** The package for `edge`, loaded with its peer set into a virtual root (#nodeFromEdge). */
  private async nodeFromEdge(edge: Edge, parent: Node | null, secondEdge: Edge | null, required: Set<Node>): Promise<Node> {
    const root = parent ?? this.virtualRoot(edge.from, false);
    const first = await this.nodeFromSpec(edge.name, edge.spec, root);
    // A second spec, where the first does not meet it: taken when it meets the first edge too.
    const second = secondEdge && !secondEdge.valid ? await this.nodeFromSpec(edge.name, secondEdge.spec, root) : null;
    const node = second && edge.valid ? second : first;
    root.tree?.attach(node, root);
    if ((required.has(edge.from) && edge.type !== 'peerOptional') || (secondEdge && required.has(secondEdge.from) && secondEdge.type !== 'peerOptional')) required.add(node);
    // A global top-level package's peers are not placed with it.
    if (this.options.shallow && edge.from.isProjectRoot) return node;
    return this.loadPeerSet(node, required);
  }

  /** Load `node`'s peers, and theirs, into its virtual root (#loadPeerSet). */
  private async loadPeerSet(node: Node, required: Set<Node>): Promise<Node> {
    const root = node.parent;
    if (!root) return node;
    const peerEdges = [...node.edgesOut.values()].filter((edge) => edge.peer && !(edge.valid && edge.to)).sort((a, b) => localeCompare(a.name, b.name));
    for (const edge of peerEdges) {
      if (edge.valid && edge.to) continue;
      const parentEdge = root.edgesOut.get(edge.name);
      const conflictOK = this.options.force === true || root.marks.sourceReference?.isProjectRoot !== true;
      if (!edge.to) {
        if (!parentEdge) {
          // An optional peer is never placed for its package: it only
          // constrains what the tree has or asks for. Where nothing in the
          // tree mentions the name it cannot conflict, and is not resolved.
          if (edge.type === 'peerOptional' && !this.tree.mentions(edge.name)) continue;
          await this.nodeFromEdge(edge, root, null, required);
          continue;
        }
        // The dependent's own spec, steered by this one.
        const dep = await this.nodeFromEdge(parentEdge, root, edge, required);
        if (edge.valid) continue;
        if (conflictOK || !required.has(dep)) {
          edge.peerConflicted = true;
          continue;
        }
        throw new PeerConflict(edge.public, `ERESOLVE unable to resolve dependency tree: ${node.name}@${node.version ?? '?'} needs peer ${edge.name}@${edge.spec}, and ${root.marks.sourceReference?.location || 'the project'} depends on ${edge.name}@${dep.version ?? parentEdge.spec}`);
      }
      // There is one already, which this peer does not accept: one that it
      // does accept replaces it, where everything relying on it accepts it.
      const current = edge.to;
      const dep = await this.nodeFromEdge(edge, null, null, required);
      if (canReplace(dep, current)) {
        await this.nodeFromEdge(edge, root, null, required);
        continue;
      }
      if (conflictOK || !required.has(edge.from)) continue;
      throw new PeerConflict(edge.public, `ERESOLVE unable to resolve dependency tree: ${node.name}@${node.version ?? '?'} needs peer ${edge.name}@${edge.spec}, which conflicts with ${current.name}@${current.version ?? '?'}`);
    }
    return node;
  }

  /** A node's problem edges: unmet (but an optional peer's), invalid, or named on the command line (#problemEdges); what its archive bundles is its own. */
  private problemEdges(node: Node): Edge[] {
    const problems: Edge[] = [];
    const bundled = new Set(node.isProjectRoot || node.pkg === null ? [] : bundledNames(node.pkg));
    for (const edge of node.edgesOut.values()) {
      if (bundled.has(edge.name)) continue;
      if (edge.to && this.loadFailures.has(edge.to)) continue;
      if (!edge.to) {
        if (edge.type !== 'peerOptional' || edge.explicit) problems.push(edge);
        continue;
      }
      if (!edge.valid || edge.explicit) problems.push(edge);
    }
    return problems;
  }

  /**
   * What the coming visits will ask, resolved ahead, a level at a time: the
   * queue's problem edges, then every edge of what they resolve to (a peer
   * also at its source's own spec, which its peer set prefers), and so on
   * down. Resolution is the host's round trip; this keeps the trips to the
   * depth of the tree, not its width. A request is expanded once.
   */
  private async prefetch(node: Node): Promise<void> {
    type Request = { name: string; range: string; from: Node | null };
    let frontier: Request[] = [node, ...this.queue].flatMap((member) => (member.tree === this.tree ? this.problemEdges(member) : []))
      .map((edge) => ({ name: edge.name, range: edge.spec, from: edge.from }));
    while (frontier.length > 0) {
      await this.resolve(frontier);
      const next: Request[] = [];
      for (const { name, range, from } of frontier) {
        const key = this.requestKey(name, range);
        if (this.expanded.has(key)) continue;
        this.expanded.add(key);
        const answer = this.resolutions.get(key);
        if (!answer || 'failed' in answer) continue;
        for (const edge of this.edgesOf(answer.package)) {
          if (edge.type === 'peerOptional' && !this.tree.mentions(edge.name)) continue;
          const peer = isPeer(edge.type);
          next.push({ name: edge.name, range: edge.range, from: peer ? from : null });
          const own = peer ? from?.edgesOut.get(edge.name) : undefined;
          if (own) next.push({ name: edge.name, range: own.spec, from });
        }
      }
      frontier = next.filter(({ name, range }) => !this.expanded.has(this.requestKey(name, range)));
    }
  }

  async build(): Promise<void> {
    // What is installed with an edge it does not meet is visited too.
    const walked = new Set<Node>();
    for (const pending = [this.tree.root]; pending.length > 0;) {
      const each = pending.pop();
      if (!each || walked.has(each)) continue;
      walked.add(each);
      if (each === this.tree.root || [...each.edgesOut.values()].some((edge) => !edge.valid)) this.push(each);
      for (const edge of each.edgesOut.values()) if (edge.to) pending.push(edge.to);
    }

    for (let node = this.pop(); node; node = this.pop()) {
      if (this.seen.has(node) || node.tree !== this.tree) continue;
      this.seen.add(node);
      const problems = this.problemEdges(node);
      if (problems.length === 0) continue;
      if (problems.some((edge) => !this.resolutions.has(this.requestKey(edge.name, edge.spec)))) await this.prefetch(node);

      const tasks: Array<{ edge: Edge; dep: Node }> = [];
      for (const edge of problems) {
        if (edge.peerConflicted) continue;
        const root = this.virtualRoot(node, true);
        const rootEdge = root.edgesOut.get(edge.name);
        const rootDep = rootEdge?.valid ? rootEdge.to : null;
        const required = new Set([edge.from]);
        const dep = rootDep && rootDep.satisfies(edge) ? rootDep : await this.nodeFromEdge(edge, edge.peer ? root : null, null, required);
        tasks.push({ edge, dep });
      }
      tasks.sort((a, b) => localeCompare(a.edge.name, b.edge.name));
      for (const { edge, dep } of tasks) this.visit(this.place(edge, dep, null, edge.explicit));
    }
  }

  private visit(placement: Placement): void {
    const { placed, edge, canPlace } = placement;
    if (placed && canPlace) {
      if (placed.marks.failed !== undefined) this.loadFailures.add(placed);
      for (const into of [...placed.edgesIn]) {
        if (into === edge || into.valid || into.peerConflicted) continue;
        if (canPlace.self === 'REPLACE') {
          this.seen.delete(into.from);
          this.push(into.from);
        } else if (!this.seen.has(into.from)) {
          this.push(into.from);
        }
      }
      this.push(placed);
      for (const dep of placement.needEvaluation) {
        this.seen.delete(dep);
        this.push(dep);
      }
    }
    for (const child of placement.children) this.visit(child);
  }

  // ── PlaceDep ──

  /** Place `dep` for `edge`, and its peers with it. */
  private place(edge: Edge, dep: Node, parent: Placement | null, explicit: boolean): Placement {
    const placement: Placement = {
      edge, dep, parent, explicit,
      start: deepestNestingTarget(parent ? parent.start : edge.from, edge.name),
      canPlace: null, canPlaceSelf: null, placed: null, children: [], needEvaluation: new Set(),
    };
    if (edge.to && edge.valid && !explicit) return placement;
    for (const target of placement.start.ancestry()) {
      const targetEdge = target.edgesOut.get(edge.name);
      if (!target.isTop && targetEdge && targetEdge.peer) continue;
      const check = new CanPlace(dep, target, edge, parent?.canPlace ?? null, [], false, explicit);
      if (check.self !== 'CONFLICT') placement.canPlaceSelf = check;
      if (check.verdict === 'CONFLICT') break;
      placement.canPlace = check;
      if (dep.marks.failed !== undefined) break;
      if (this.options.shallow && target.parent?.isProjectRoot) break;
    }
    if (!placement.canPlace) {
      const top = topOf(placement);
      if (!this.options.force && this.isMine(top.edge)) {
        const current = top.edge.from.resolve(top.edge.name);
        throw new PeerConflict(top.edge.public, `ERESOLVE could not resolve: ${top.dep.name}@${top.dep.version ?? top.edge.spec} for ${top.edge.from.location || 'the project'}${current?.version ? `, which has ${current.name}@${current.version}` : ''}`);
      }
      if (!placement.canPlaceSelf) {
        this.warnPeerConflict(edge, dep);
        return placement;
      }
      placement.canPlace = placement.canPlaceSelf;
    }
    const { target } = placement.canPlace;
    if (placement.canPlace.verdict === 'KEEP') {
      if (edge.peer && !edge.valid) this.warnPeerConflict(edge, dep);
      this.pruneDedupable(target, true);
      return placement;
    }

    // A copy of the package goes in the tree; past the nesting cap (a cycle
    // of incompatible ranges), a failure instead.
    const nests = target.depth + 1 > MAX_NEST_DEPTH && dep.marks.failed === undefined;
    const placed = nests
      ? new Node(dep.name, null, 'planned', { failed: `${dep.name}@${dep.version ?? edge.spec} from ${edge.from.location || 'the project'} would nest deeper than ${MAX_NEST_DEPTH} levels (cycle with incompatible ranges)`, placedFor: edge.public }, [])
      : new Node(dep.name, dep.pkg, 'planned', { ...dep.marks, placedFor: edge.public }, this.edgesOf(dep.pkg));
    placement.placed = placed;
    const old = target.children.get(edge.name);
    if (old) this.replaceOld(placement, placed, old);
    else this.tree.attach(placed, target);
    if (edge.peer && !placed.satisfies(edge)) this.warnPeerConflict(edge, dep);
    if (edge.valid && edge.to && edge.to !== placed) this.pruneDedupable(edge.to, false);
    for (const node of [...this.tree.named(edge.name)]) {
      if (node.tree !== this.tree || !node.isDescendantOf(target) || node.isTop) continue;
      this.pruneDedupable(node, false);
      if (node.tree === this.tree) for (const kid of [...node.children.values()]) this.pruneDedupable(kid, false);
    }
    // Its peers go with it, where they go.
    const members = dep.parent?.children;
    for (const peerEdge of [...placed.edgesOut.values()]) {
      if (peerEdge.valid || !peerEdge.peer || peerEdge.peerConflicted) continue;
      const peer = members?.get(peerEdge.name);
      if (!peer || !peer.satisfies(peerEdge)) continue;
      placement.children.push(this.place(peerEdge, peer, placement, explicit));
    }
    return placement;
  }

  /** Replace `old` with `placed` (replaceOldDep): what only the old one needed goes, and peer sets it no longer meets are looked at again. */
  private replaceOld(placement: Placement, placed: Node, old: Node): void {
    const target = old.parent;
    if (!target) return;
    const oldDeps: Node[] = [];
    for (const [name, edge] of old.edgesOut) {
      const to = edge.to;
      if (!placed.edgesOut.has(name) && to) oldDeps.push(...gatherDepSet([to], (e) => e.to !== to));
    }
    const prunePeerSets: Node[] = [];
    for (const edge of [...old.edgesIn]) {
      if (placed.satisfies(edge) || !edge.peer || edge.from.parent !== target || edge.peerConflicted) continue;
      for (const entry of peerEntrySets(edge.from).keys()) {
        const entryNode = entry.to;
        if (!entryNode) continue;
        // As npm reckons it: the entry node's own place (deepestNestingTarget with no name).
        if (deepestNestingTarget(entryNode, undefined) !== target && !entry.from.isProjectRoot) {
          prunePeerSets.push(...gatherDepSet([entryNode], (e) => e.to !== entryNode && !e.peerConflicted));
        } else {
          this.warnPeerConflict(edge, placement.dep);
        }
      }
    }
    this.tree.replace(placed, old);
    this.pruneForReplacement(placed, oldDeps);
    for (const dep of prunePeerSets) {
      for (const into of dep.edgesIn) placement.needEvaluation.add(into.from);
      this.tree.detach(dep);
    }
  }

  private pruneForReplacement(node: Node, oldDeps: readonly Node[]): void {
    const invalid = new Set<Node>();
    for (const edge of node.edgesOut.values()) if (edge.to && !edge.valid) invalid.add(edge.to);
    for (const dep of oldDeps) for (const each of gatherDepSet([dep], (e) => e.to !== dep && e.valid)) invalid.add(each);
    for (const dep of gatherDepSet(invalid, (e) => e.from !== node && e.to !== node && e.valid)) this.tree.detach(dep);
  }

  private pruneDedupable(node: Node, descend: boolean): void {
    if (node.tree !== this.tree) return;
    if (canDedupe(node, false)) {
      for (const dep of gatherDepSet([node], (e) => e.to !== node && e.valid)) this.tree.detach(dep);
      return;
    }
    if (!descend) return;
    for (const child of [...node.children.values()].sort((a, b) => localeCompare(a.location, b.location))) this.pruneDedupable(child, true);
  }

  /** Whether the conflict at `edge` is the project's own (PlaceDep.isMine). */
  private isMine(edge: Edge): boolean {
    const node = edge.from;
    if (node.isProjectRoot) return true;
    if (!edge.peer) return false;
    let peerEdges = false;
    for (const into of node.edgesIn) {
      if (into.peer) {
        peerEdges = true;
        continue;
      }
      if (into.from.isProjectRoot) return true;
    }
    if (peerEdges) for (const entry of peerEntrySets(node).keys()) if (entry.from.isProjectRoot) return true;
    return false;
  }

  private warnPeerConflict(edge: Edge, dep: Node): void {
    edge.peerConflicted = true;
    const current = edge.from.resolve(edge.name);
    this.warnings.push(`ERESOLVE overriding peer dependency: ${edge.from.location || 'the project'} wants ${edge.name}@${edge.spec}` +
      `${current?.version ? `, the tree has ${current.name}@${current.version}` : ''}${dep.version ? `, found ${dep.name}@${dep.version}` : ''}`);
  }
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** Plan the tree `roots` need over what is `installed`, from what `host` answers. */
export async function planTree<P extends TreePackage, I extends TreePackage>(
  roots: readonly TreeRoot[],
  installed: ReadonlyArray<InstalledPackage<I>>,
  host: TreeHost<P>,
  options: PlanOptions = {},
): Promise<TreePlan<P, I>> {
  const project = new Node('', null, 'project', {}, roots.map(({ name, range, type, explicit }) => ({ name, range, type, explicit })));
  const tree = new Tree(project, options.shallow === true);
  const builder = new Builder<P>(tree, host, options);

  // The installed tree, each package in its folder.
  const installedAt = new Map<string, Node>([['', project]]);
  for (const entry of [...installed].sort((a, b) => depthOf(a.at) - depthOf(b.at))) {
    const slash = entry.at.lastIndexOf('/node_modules/');
    const parent = installedAt.get(slash < 0 ? '' : entry.at.slice(0, slash));
    if (!parent) continue;
    const name = slash < 0 ? entry.at : entry.at.slice(slash + '/node_modules/'.length);
    const node = 'failed' in entry
      ? new Node(name, null, 'installed', { failed: entry.failed }, [])
      : new Node(name, entry.pkg, 'installed', { refused: entry.refused, skipIfOptional: entry.skipIfOptional }, builder.edgesOf(entry.pkg));
    tree.attach(node, parent);
    installedAt.set(entry.at, node);
    if (node.marks.failed !== undefined) builder.loadFailures.add(node);
  }

  const failures = new Map<string, TreeFailure>();
  if (!options.frozen) {
    try {
      await builder.build();
    } catch (error) {
      if (!(error instanceof PeerConflict)) throw error;
      failures.set('!ERESOLVE', { edge: error.edge, reason: error.message, refused: false, id: '!ERESOLVE' });
    }
  }
  for (const message of builder.warnings) await host.warn?.(message);

  // ── calc-dep-flags: what the project reaches, and through which edges ──
  // What the project's edges reach, and what its required edges reach: a
  // folder holding one is kept with it (calc-dep-flags' resetParents), but
  // only edges are followed.
  const reached = new Set<Node>();
  const required = new Set<Node>();
  const prod = new Set<Node>();
  const mark = (flagged: Set<Node>, start: Node, follow: (edge: Edge) => boolean) => {
    const pending = [start];
    for (let each = pending.pop(); each; each = pending.pop()) {
      if (flagged.has(each)) continue;
      flagged.add(each);
      for (const edge of each.edgesOut.values()) if (edge.to && follow(edge)) pending.push(edge.to);
    }
  };
  for (const edge of project.edgesOut.values()) {
    if (!edge.to) continue;
    mark(reached, edge.to, () => true);
    if (!edge.optional) mark(required, edge.to, (e) => !e.optional);
    if (edge.type !== 'dev') mark(prod, edge.to, () => true);
  }
  const withFolders = (flagged: Set<Node>) => {
    for (const each of [...flagged]) for (let up = each.parent; up && !up.isProjectRoot; up = up.parent) flagged.add(up);
  };
  withFolders(reached);
  withFolders(required);
  withFolders(prod);

  // ── What the project does not reach is extraneous, and goes from a tree installed before; a frozen tree is installed as it is ──
  if (!options.frozen && installed.length > 0) for (const each of [...tree.nodes()]) if (each.tree === tree && !reached.has(each)) tree.detach(each);
  const extraneous = new Set<string>();
  for (const [at, each] of installedAt) if (at !== '' && each.tree !== tree) extraneous.add(at);

  // The tree, as the hosts get it, before anything is left out of it.
  const nodes = new Map<string, TreeNode<P, I>>();
  const requiredAt = new Set<string>();
  const dev = new Set<string>();
  for (const each of tree.nodes()) {
    const at = each.location;
    if (required.has(each)) requiredAt.add(at);
    // A node no prod edge reaches is dev, but a locked one nothing reaches,
    // whose flags are the lock's (an extraneous entry is installed by ci).
    if (!prod.has(each) && (reached.has(each) || !options.frozen)) dev.add(at);
    if (each.pkg === null) continue;
    // The host's own packages, under the types it gave them.
    nodes.set(at, each.origin === 'planned' && each.marks.placedFor
      ? { at, planned: true, pkg: each.pkg as P, edge: each.marks.placedFor }
      : { at, planned: false, pkg: each.pkg as I });
  }

  // ── A package that failed to load, or is refused: a required one fails the install, an optional one goes with its optional set ──
  const skipped = new Set<string>();
  const reasons = new Map<string, string>();
  const leaveOut = (start: Node, reason: string): ReadonlySet<string> | null => {
    if (required.has(start)) return null;
    reasons.set(start.location, reason);
    // The set, and what is beneath each member's folder, which goes with it.
    const set = optionalSet(start);
    for (const member of set) for (const each of [member, ...descendants(member)]) skipped.add(each.location);
    for (const member of set) tree.detach(member);
    return skipped;
  };
  const failure = (each: Node, reason: string, refused: boolean) => {
    const id = each.location;
    failures.set(id, {
      edge: each.marks.placedFor ?? { name: each.name, range: '*', from: each.parent?.location ?? '', type: 'prod', explicit: false },
      reason, refused, id,
    });
    if (required.has(each)) requiredAt.add(id);
    else leaveOut(each, reason);
  };
  for (const each of [...builder.loadFailures]) if (each.tree === tree && each.marks.failed !== undefined) failure(each, each.marks.failed, false);
  for (const each of [...tree.nodes()]) if (each.tree === tree && each.marks.refused !== undefined) failure(each, each.marks.refused, true);
  for (const each of [...tree.nodes()]) if (each.tree === tree && each.marks.skipIfOptional !== undefined && !required.has(each)) leaveOut(each, each.marks.skipIfOptional);
  if (failures.has('!ERESOLVE')) requiredAt.add('!ERESOLVE');

  const byPlacement = new Map([...tree.nodes()].map((each) => [each.location, each]));
  return {
    nodes,
    resolvedAny: builder.resolutions.size > 0,
    failures: [...failures.values()],
    required: requiredAt,
    dev,
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
