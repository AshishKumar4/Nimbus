/**
 * Placement paths: where a package lands, relative to the project's
 * `node_modules` — `react` at root, `pkg-types/node_modules/confbox` nested
 * under the dependent whose range root does not satisfy. Node walks
 * `node_modules` upward from the importer, so a nested copy is found by its
 * dependent (and what is beneath it) and by nobody else.
 */

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
