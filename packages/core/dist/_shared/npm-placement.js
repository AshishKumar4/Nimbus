/**
 * npm-placement.ts — where a package lands in `node_modules`, for both of
 * Nimbus's install engines: the worker's resolver walk (worker
 * npm/installer.ts) and the shell's fallback npm (lifo
 * commands/system/npm.ts). Each walks the dependency graph breadth-first and
 * asks decidePlacement about every edge; what they differ in is how they
 * fetch (a layer of resolver facets at once, or one package at a time).
 *
 * Placement paths are relative to the project's `node_modules`: `react` at
 * root, `pkg-types/node_modules/confbox` nested under the dependent whose
 * range root does not satisfy. Node walks `node_modules` upward from the
 * importer, so a nested copy is found by its dependent (and what is beneath
 * it) and by nobody else.
 *
 * An edge is decided against what Node's walk from its dependent sees, as
 * npm's arborist places it: met by the nearest visible copy when that copy
 * satisfies the range (any copy, for a range that is not semver: a tag or a
 * URL); else, when the nearest copy does not satisfy, a copy nested under
 * the dependent; else, with no copy visible, one at root. A peer is never
 * nested: a duplicate is worse than a mismatch (two Reacts break hooks), so
 * the nearest copy meets it whatever its version, and the walk says so. An
 * edge whose nearest visible placement is still resolving waits for it: a
 * copy nested under a package is decided in the layer after that package
 * resolves, before anything beneath it can, so no descendant is decided
 * against a copy that will later shadow it.
 */
import { isSemverRange, satisfiesRange } from './npm-semver.js';
import { parseRegistryRequest } from './npm-spec.js';
const NM = '/node_modules/';
/** `name` under `parent`; `''` is the project itself. */
export function nestedPlacement(parent, name) {
    return parent ? `${parent}${NM}${name}` : name;
}
/** The containing placement, `''` at root. */
function parentPlacement(placement) {
    const i = placement.lastIndexOf(NM);
    return i < 0 ? '' : placement.slice(0, i);
}
/** The package name a placement holds. */
export function placementName(placement) {
    const i = placement.lastIndexOf(NM);
    return i < 0 ? placement : placement.slice(i + NM.length);
}
/** Placements Node's walk visits for `name` from inside `from`, nearest first, root last. */
export function visiblePlacements(from, name) {
    const out = [];
    let dir = from;
    while (dir) {
        out.push(`${dir}${NM}${name}`);
        dir = parentPlacement(dir);
    }
    out.push(name);
    return out;
}
/**
 * A cycle with mutually incompatible ranges has no finite layout: an edge
 * that would nest deeper than this is refused rather than nested without end.
 */
export const MAX_NEST_DEPTH = 16;
/**
 * Where `edge` goes, given the walk's `placed` packages (by placement; a
 * placement that failed is absent, and the walk looks past it) and its
 * `pending` placements (dispatched, unanswered).
 */
export function decidePlacement(edge, placed, pending) {
    const { range } = parseRegistryRequest(edge.name, edge.range);
    let at = edge.name;
    for (const candidate of visiblePlacements(edge.from, edge.name)) {
        if (pending.has(candidate))
            return { kind: 'wait' };
        const pkg = placed.get(candidate);
        if (!pkg)
            continue;
        if (!isSemverRange(range) || satisfiesRange(pkg.version, range))
            return { kind: 'met', at: candidate, mismatch: false };
        if (edge.kind === 'peer')
            return { kind: 'met', at: candidate, mismatch: true };
        at = nestedPlacement(edge.from, edge.name);
        break;
    }
    return at.split(NM).length - 1 > MAX_NEST_DEPTH ? { kind: 'too-deep', at } : { kind: 'place', at };
}
