declare const facetTaskTypes: unique symbol;

/** A complete build-time expression, never a closure captured from the host bundle. */
export interface FacetTaskSource<A, R> {
  readonly kind: 'nimbus-facet-task';
  readonly source: string;
  readonly [facetTaskTypes]?: (args: A) => R | Promise<R>;
}

export function facetTaskSource<A, R>(source: string): FacetTaskSource<A, R> {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('Facet task source must be a nonempty compiled expression');
  return Object.freeze({ kind: 'nimbus-facet-task', source });
}

export function requireFacetTaskSource<A, R>(value: FacetTaskSource<A, R>): string {
  if (!value || value.kind !== 'nimbus-facet-task' || typeof value.source !== 'string' || !value.source.trim()) {
    throw new TypeError('Facet submit requires a precompiled task-source value, not a function or closure');
  }
  return value.source;
}
