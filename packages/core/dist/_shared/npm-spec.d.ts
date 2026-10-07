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
export declare function packageRangeSeparator(spec: string): number;
/**
 * Parse an npm spec into install-name / registry-name / range. `npm:`
 * aliases redirect the registry lookup to a different package while the
 * dep records the alias as the install name; everything else is the
 * identity. Every npm here reads a spec through it: the worker's resolver
 * facet (its preamble embeds it by source), the installer's lockfile check
 * (which reads the inner range out of an alias spec), and the shell's
 * fallback npm.
 */
export declare function parseRegistryRequest(name: string, range: string): {
    installName: string;
    registryName: string;
    range: string;
    alias: boolean;
};
//# sourceMappingURL=npm-spec.d.ts.map