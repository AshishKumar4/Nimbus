/**
 * can-place.ts — whether a package may go into a folder for an edge, with
 * its peers (can-place-dep.js): OK, REPLACE what is there, KEEP what is
 * there, or CONFLICT. Reads the tree; never changes it.
 */
import type { Edge, HostPackages, Node } from './model.js';
export type Verdict = 'OK' | 'REPLACE' | 'KEEP' | 'CONFLICT';
/** `dep` (a member of its virtual root's peer set) in `target`'s node_modules for `edge` (CanPlaceDep). */
export declare class CanPlace<H extends HostPackages> {
    readonly dep: Node<H>;
    readonly target: Node<H>;
    readonly edge: Edge<H>;
    private readonly parent;
    private readonly peerPath;
    private readonly explicit;
    readonly verdict: Verdict;
    /** Its own verdict, the peers aside (canPlaceSelf). */
    self: Verdict | null;
    private readonly current;
    private readonly targetEdge;
    private readonly edgeOverride;
    private readonly preferDedupe;
    private peersChecked;
    constructor(dep: Node<H>, target: Node<H>, edge: Edge<H>, parent: CanPlace<H> | null, peerPath: readonly Node<H>[], preferDedupe: boolean, explicit: boolean);
    get top(): CanPlace<H>;
    get deepest(): Node<H>;
    private check;
    private checkCurrent;
    private checkNoCurrent;
    /** Whether the peers of `dep` can go with it: `state`, or CONFLICT. */
    private peers;
}
//# sourceMappingURL=can-place.d.ts.map