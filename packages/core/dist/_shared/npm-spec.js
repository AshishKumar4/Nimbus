/**
 * npm-spec.ts — where a package spec's name ends and its range begins:
 * `name@range`, `@scope/name@range`, as npm's npa reads it, for every npm
 * here (the worker's installer and npx, and the shell's fallback npm).
 * Self-contained: the resolver facet's preamble embeds both functions by
 * `toString()` (worker loaders/npm-resolve-preamble.ts), so they call
 * nothing outside this file.
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
/**
 * Parse an npm spec into install-name / registry-name / range. `npm:`
 * aliases redirect the registry lookup to a different package while the
 * dep records the alias as the install name; everything else is the
 * identity. Every npm here reads a spec through it: the worker's resolver
 * facet (its preamble embeds it by source), the installer's lockfile check
 * (which reads the inner range out of an alias spec), and the shell's
 * fallback npm.
 */
export function parseRegistryRequest(name, range) {
    const text = String(range || 'latest');
    if (!text.startsWith('npm:')) {
        return { installName: name, registryName: name, range: text, alias: false };
    }
    const target = text.slice(4);
    const splitAt = packageRangeSeparator(target);
    const registryName = splitAt >= 0 ? target.slice(0, splitAt) : target;
    const targetRange = splitAt >= 0 ? target.slice(splitAt + 1) : 'latest';
    return {
        installName: name,
        registryName: registryName || name,
        range: targetRange || 'latest',
        alias: true,
    };
}
