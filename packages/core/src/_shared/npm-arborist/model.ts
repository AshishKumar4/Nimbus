/**
 * model.ts — the tree npm's arborist builds (node.js, edge.js): nodes in
 * node_modules folders, the edges between them, and each edge's target, the
 * copy Node's walk finds from its dependent, kept current as nodes come and
 * go. A node carries what it is (Payload): the project, a virtual root, a
 * package installed before this install, a package resolved for it (a
 * candidate in a virtual root, or a copy placed in the tree), or one that
 * failed to load; a host's own package types are kept through it.
 */

import { versionAtLeast } from '../npm-semver.js';
import { bundledNames, edgeRequest, isOptional, isPeer, meets, type EdgeRequest, type EdgeType, type TreeEdge, type TreePackage } from '../npm-tree.js';
import type { HostVerdicts, LockFlags } from './plan.js';
import { gatherDepSet } from './sets.js';

/** npm's string order (@isaacs/string-locale-compare's 'en'), one collator for every comparison. */
export const localeCompare = new Intl.Collator('en').compare;

/** The package types a host gives the engine: what it resolves, and what it says is installed. */
export interface HostPackages {
  readonly resolved: TreePackage;
  readonly installed: TreePackage;
}

/** What a node is. */
export type Payload<H extends HostPackages> =
  | { readonly kind: 'project' }
  /** A root outside the tree with `source`'s edges, where a package and its peers are loaded (#virtualRoot). */
  | { readonly kind: 'virtual-root'; readonly source: Node<H> }
  | ({ readonly kind: 'installed'; readonly pkg: H['installed']; readonly lock?: LockFlags } & HostVerdicts)
  /** Resolved for an edge, in a virtual root. */
  | ({ readonly kind: 'candidate'; readonly pkg: H['resolved'] } & HostVerdicts)
  /** Resolved and placed in the tree, for `placedFor`. */
  | ({ readonly kind: 'placed'; readonly pkg: H['resolved']; readonly placedFor: TreeEdge } & HostVerdicts)
  /** No package: it could not be resolved, or nested. */
  | { readonly kind: 'failed'; readonly reason: string; readonly placedFor?: TreeEdge };

/** An edge as a manifest declares it. */
export type EdgeDefinition = Pick<TreeEdge, 'name' | 'range' | 'type'> & { readonly explicit?: boolean };

export class Edge<H extends HostPackages> {
  /** The node Node's walk finds from `from`, kept current by its tree. */
  to: Node<H> | null = null;
  peerConflicted = false;
  /** What its spec asks for, read once. */
  readonly request: EdgeRequest;
  /** Which versions it accepts, by version: a tree asks one edge of one version many times. */
  private readonly accepted = new Map<string, boolean>();

  constructor(readonly from: Node<H>, readonly name: string, readonly spec: string, readonly type: EdgeType, readonly explicit: boolean) {
    this.request = edgeRequest(name, spec);
  }

  /** Whether a package at `version` meets it (dep-valid: an alias by its target's range, whatever package fills it); none meets a spec no registry answers. */
  accepts(version: string): boolean {
    if (!this.request.registry) return false;
    let answer = this.accepted.get(version);
    if (answer === undefined) {
      answer = meets(version, { name: this.name, range: this.spec });
      this.accepted.set(version, answer);
    }
    return answer;
  }

  get peer(): boolean { return isPeer(this.type); }
  get optional(): boolean { return isOptional(this.type); }

  /** Edge.error is null: met, or optional and absent; never a peer inside its own dependent (PEER LOCAL), but a top's. */
  get valid(): boolean {
    if (this.to === null) return this.optional;
    if (this.peer && this.to.parent === this.from && !this.from.isTop) return false;
    return this.to.satisfies(this);
  }

  get definition(): EdgeDefinition { return { name: this.name, range: this.spec, type: this.type, explicit: this.explicit }; }
  get public(): TreeEdge { return { name: this.name, range: this.spec, from: this.from.location, type: this.type, explicit: this.explicit }; }
}

export class Node<H extends HostPackages> {
  readonly children = new Map<string, Node<H>>();
  readonly edgesOut = new Map<string, Edge<H>>();
  readonly edgesIn = new Set<Edge<H>>();
  parent: Node<H> | null = null;
  /** The tree it is in; null once taken out. */
  tree: Tree<H> | null = null;

  constructor(readonly name: string, readonly payload: Payload<H>, edges: readonly EdgeDefinition[]) {
    for (const { name: dep, range, type, explicit } of edges) this.edgesOut.set(dep, new Edge(this, dep, range, type, explicit === true));
  }

  /** Its package; null for the project and one that failed. */
  get pkg(): TreePackage | null {
    switch (this.payload.kind) {
      case 'project':
      case 'failed':
        return null;
      case 'virtual-root':
        return this.payload.source.pkg;
      default:
        return this.payload.pkg;
    }
  }

  get failed(): string | undefined { return this.payload.kind === 'failed' ? this.payload.reason : undefined; }
  get verdicts(): HostVerdicts {
    const { payload } = this;
    return payload.kind === 'installed' || payload.kind === 'candidate' || payload.kind === 'placed' ? payload : {};
  }

  /** The root of its tree: the project, or a virtual root (`this === this.root`). */
  get isProjectRoot(): boolean { return this.payload.kind === 'project' || this.payload.kind === 'virtual-root'; }
  /** A top-level package of a global prefix. */
  get globalTop(): boolean { return this.tree?.global === true && this.parent?.isProjectRoot === true; }
  get isTop(): boolean { return this.parent === null || this.globalTop; }
  get version(): string | null { return this.pkg?.version ?? null; }

  get location(): string {
    if (this.parent === null) return '';
    const parent = this.parent.location;
    return parent ? `${parent}/node_modules/${this.name}` : this.name;
  }

  /** Folders below its top: a top (the project, a virtual root, a global prefix's package) is at 0. */
  get depth(): number {
    const { parent } = this;
    return parent === null || this.globalTop ? 0 : parent.depth + 1;
  }

  isDescendantOf(ancestor: Node<H>): boolean {
    for (let node: Node<H> | null = this; node; node = node.parent) if (node === ancestor) return true;
    return false;
  }

  /** The copy Node's walk finds for `name` from here. */
  resolve(name: string): Node<H> | null {
    for (let node: Node<H> | null = this; node; node = node.parent) {
      const child = node.children.get(name);
      if (child) return child;
    }
    return null;
  }

  satisfies(edge: Edge<H>): boolean {
    const { pkg } = this;
    return pkg !== null && edge.name === this.name && edge.accepts(pkg.version);
  }

  /** The same package (Node.matches): by integrity where both know it, else the same package at the same version. */
  matches(other: Node<H>): boolean {
    const mine = this.pkg;
    const theirs = other.pkg;
    if (mine === null || theirs === null || this.name !== other.name) return false;
    if (mine.integrity && theirs.integrity) return mine.integrity === theirs.integrity;
    return (mine.registryName ?? this.name) === (theirs.registryName ?? other.name) && mine.version === theirs.version;
  }

  /** Whether `this` may stand in for `old`: every edge into `old` from outside what only `old` needs accepts it (canReplaceWith). */
  canReplace(old: Node<H>, ignorePeers: Iterable<string> = []): boolean {
    if (this.name !== old.name) return false;
    const mine = this.pkg?.registryName;
    const theirs = old.pkg?.registryName;
    if (mine !== undefined && theirs !== undefined && mine !== theirs) return false;
    const ignored = new Set(ignorePeers);
    const depSet = gatherDepSet([old], (edge) => edge.to !== old && edge.valid);
    for (const edge of old.edgesIn) {
      if (!old.isTop && edge.from.parent === old.parent && edge.peer && ignored.has(edge.from.name)) continue;
      if (!depSet.has(edge.from) && !this.satisfies(edge)) return false;
    }
    return true;
  }

  /** Whether it came in a package's archive: a name its parent, or an ancestor between, bundles (inDepBundle). */
  get inDepBundle(): boolean {
    for (let child: Node<H> = this, parent = this.parent; parent && !parent.isProjectRoot; child = parent, parent = parent.parent) {
      const pkg = parent.pkg;
      if (pkg !== null && bundledNames(pkg).includes(child.name)) return true;
    }
    return false;
  }

  /** Whether it is a needless copy: nothing wants it, or a copy two folders up does as well; never a bundled one (canDedupe). */
  canDedupe(preferDedupe: boolean): boolean {
    if (this.inDepBundle) return false;
    const grandparent = this.parent?.parent;
    if (!grandparent) return false;
    if (this.edgesIn.size === 0) return true;
    const other = grandparent.resolve(this.name);
    if (!other) return false;
    if (other.matches(this)) return true;
    if (!other.canReplace(this)) return false;
    return preferDedupe || (other.version !== null && this.version !== null && versionAtLeast(other.version, this.version));
  }
}

/** One tree of nodes (the ideal tree, or a virtual root's), every edge's target kept current as nodes come and go. */
export class Tree<H extends HostPackages> {
  private readonly edgesByName = new Map<string, Set<Edge<H>>>();
  private readonly byName = new Map<string, Set<Node<H>>>();
  /**
   * Every node in the tree, the root first, in the order each joined it
   * (npm's inventory): a node moved within the tree keeps its place, as
   * npm's keeps a node whose root does not change.
   */
  readonly inventory = new Set<Node<H>>();

  constructor(readonly root: Node<H>, readonly global: boolean) {
    this.register(root);
  }

  named(name: string): ReadonlySet<Node<H>> { return this.byName.get(name) ?? new Set(); }

  /** Whether anything in the tree is, or asks for, `name`. */
  mentions(name: string): boolean { return (this.byName.get(name)?.size ?? 0) > 0 || (this.edgesByName.get(name)?.size ?? 0) > 0; }

  *nodes(): Generator<Node<H>> {
    yield* descendants(this.root);
  }

  /** Put `node` in `parent`'s node_modules, where what was there goes. */
  attach(node: Node<H>, parent: Node<H>): void {
    if (node.parent === parent && parent.children.get(node.name) === node) return;
    const old = parent.children.get(node.name);
    if (old) this.detach(old);
    if (node.parent) node.tree?.take(node, node.tree === this);
    node.parent = parent;
    parent.children.set(node.name, node);
    for (const each of [node, ...descendants(node)]) this.register(each);
    this.reload(node.name, parent);
  }

  /** Put `node` where `old` is: it takes what `old` holds (Node.replace). */
  replace(node: Node<H>, old: Node<H>): void {
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
  detach(node: Node<H>): void {
    this.take(node, false);
  }

  /** `node` out of its folder; `moving`: to another in this tree, its place in the inventory kept. */
  private take(node: Node<H>, moving: boolean): void {
    const parent = node.parent;
    if (parent === null || node.tree !== this) return;
    parent.children.delete(node.name);
    node.parent = null;
    for (const each of [node, ...descendants(node)]) this.unregister(each, moving);
    this.reload(node.name, parent);
  }

  private register(node: Node<H>): void {
    node.tree = this;
    this.inventory.add(node);
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

  private unregister(node: Node<H>, moving = false): void {
    node.tree = null;
    if (!moving) this.inventory.delete(node);
    this.byName.get(node.name)?.delete(node);
    for (const edge of node.edgesOut.values()) {
      this.edgesByName.get(edge.name)?.delete(edge);
      edge.to?.edgesIn.delete(edge);
      edge.to = null;
    }
  }

  /** Every edge for `name` from `parent` or beneath it, retargeted. */
  private reload(name: string, parent: Node<H>): void {
    for (const edge of [...this.edgesByName.get(name) ?? []]) if (edge.from.isDescendantOf(parent)) this.retarget(edge);
  }

  private retarget(edge: Edge<H>): void {
    const to = edge.from.resolve(edge.name);
    if (to === edge.to) return;
    edge.to?.edgesIn.delete(edge);
    edge.to = to;
    to?.edgesIn.add(edge);
  }
}

/** Every node beneath `node`'s folder. */
export function* descendants<H extends HostPackages>(node: Node<H>): Generator<Node<H>> {
  const pending = [...node.children.values()];
  for (let each = pending.pop(); each; each = pending.pop()) {
    yield each;
    pending.push(...each.children.values());
  }
}
