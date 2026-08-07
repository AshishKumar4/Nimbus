export function getFacetManagerLoaderHost(facetMgr) {
    const env = Reflect.get(facetMgr, 'env');
    const ctx = Reflect.get(facetMgr, 'ctx');
    if (!isDurableObjectState(ctx)) {
        throw new Error('a loader-backed runtime requires a FacetManager with DurableObjectState context');
    }
    return { env, ctx };
}
function isDurableObjectState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
