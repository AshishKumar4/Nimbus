/**
 * npm/package-spec.ts — where a package spec's name ends and its range
 * begins: `name@range`, `@scope/name@range`. Self-contained: the resolver
 * facet's preamble embeds it by `toString()` beside parseRegistryRequest
 * (loaders/npm-resolve-preamble.ts), so it calls nothing outside itself.
 */
/**
 * The index of the `@` between a spec's package name and its range: the
 * first `@` after the scope's `/` for a scoped name, the first `@` for any
 * other; -1 when the spec names no range (or is a scope with no name).
 */
export function packageRangeSeparator(spec) {
    if (!spec)
        return -1;
    if (spec[0] !== '@')
        return spec.indexOf('@');
    const slash = spec.indexOf('/');
    if (slash < 0)
        return -1;
    return spec.indexOf('@', slash + 1);
}
