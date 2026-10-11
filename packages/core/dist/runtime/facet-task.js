export function facetTaskSource(source) {
    if (typeof source !== 'string' || !source.trim())
        throw new TypeError('Facet task source must be a nonempty compiled expression');
    return Object.freeze({ kind: 'nimbus-facet-task', source });
}
export function requireFacetTaskSource(value) {
    if (!value || value.kind !== 'nimbus-facet-task' || typeof value.source !== 'string' || !value.source.trim()) {
        throw new TypeError('Facet submit requires a precompiled task-source value, not a function or closure');
    }
    return value.source;
}
