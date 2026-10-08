/** What a spec asks the registry for: the name it installs under, the package and range it fetches, and whether it is an `npm:` alias. */
export interface RegistryRequest {
    installName: string;
    registryName: string;
    range: string;
    alias: boolean;
}
/**
 * The package a command-line spec names and the range it asks for, as npa
 * splits `name[@range]` (`@scope/name@range`, `name@npm:other@range`); the
 * range is null when the spec gives none, and a spec that names no package
 * (a path, a git repository, a URL) is its own name.
 */
export declare function splitPackageSpec(spec: string): {
    name: string;
    range: string | null;
};
/**
 * The registry request a dependency `name` with `range` makes: an `npm:`
 * alias fetches the package it names, at its range, and installs it under
 * `name`; anything else fetches `name` at `range` (a non-registry spec too,
 * whose range the picker reads as no range).
 */
export declare function parseRegistryRequest(name: string, range: string): RegistryRequest;
//# sourceMappingURL=npm-spec.d.ts.map