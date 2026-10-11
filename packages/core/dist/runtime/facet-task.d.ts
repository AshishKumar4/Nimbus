declare const facetTaskTypes: unique symbol;
/** A complete build-time expression, never a closure captured from the host bundle. */
export interface FacetTaskSource<A, R> {
    readonly kind: 'nimbus-facet-task';
    readonly source: string;
    readonly [facetTaskTypes]?: (args: A) => R | Promise<R>;
}
export declare function facetTaskSource<A, R>(source: string): FacetTaskSource<A, R>;
export declare function requireFacetTaskSource<A, R>(value: FacetTaskSource<A, R>): string;
export {};
//# sourceMappingURL=facet-task.d.ts.map