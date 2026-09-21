/**
 * Placement paths: where a package lands, relative to the project's
 * `node_modules` — `react` at root, `pkg-types/node_modules/confbox` nested
 * under the dependent whose range root does not satisfy. Node walks
 * `node_modules` upward from the importer, so a nested copy is found by its
 * dependent (and what is beneath it) and by nobody else.
 */
/** `name` under `parent`; `''` is the project itself. */
export declare function nestedPlacement(parent: string, name: string): string;
/** The containing placement, `''` at root. */
export declare function parentPlacement(placement: string): string;
/** The package name a placement holds. */
export declare function placementName(placement: string): string;
/** Placements Node's walk visits for `name` from inside `from`, nearest first, root last. */
export declare function visiblePlacements(from: string, name: string): string[];
//# sourceMappingURL=placement.d.ts.map