/**
 * npm-spec.ts — a package spec as npm reads it, with npm's own
 * npm-package-arg, for every npm here: the worker's installer and npx, the
 * resolver facet (the build bundles this module into its preamble, worker
 * scripts/bundle-facet-workers.mjs), and the shell's fallback npm.
 */
import npa from 'npm-package-arg';
/**
 * The package a command-line spec names and the range it asks for, as npa
 * splits `name[@range]` (`@scope/name@range`, `name@npm:other@range`); the
 * range is null when the spec gives none, and a spec that names no package
 * (a path, a git repository, a URL) is its own name.
 */
export function splitPackageSpec(spec) {
    let parsed;
    try {
        parsed = npa(spec);
    }
    catch {
        return { name: spec, range: null };
    }
    const name = parsed.name;
    if (!name || !spec.startsWith(name))
        return { name: spec, range: null };
    return spec.length > name.length && spec[name.length] === '@'
        ? { name, range: spec.slice(name.length + 1) }
        : { name: spec, range: null };
}
/**
 * The registry request a dependency `name` with `range` makes: an `npm:`
 * alias fetches the package it names, at its range, and installs it under
 * `name`; anything else fetches `name` at `range` (a non-registry spec too,
 * whose range the picker reads as no range).
 */
export function parseRegistryRequest(name, range) {
    const text = String(range || 'latest');
    let parsed = null;
    try {
        parsed = npa.resolve(name, text);
    }
    catch {
        parsed = null;
    }
    const target = parsed?.type === 'alias' ? parsed.subSpec : undefined;
    if (target?.name)
        return { installName: name, registryName: target.name, range: target.rawSpec, alias: true };
    return { installName: name, registryName: name, range: text, alias: false };
}
