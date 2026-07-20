/**
 * Shared npm resolution types, cache serialization, and hoisting.
 *
 * Registry resolution runs in fanout facets; this module contains only the
 * supervisor-side contracts and computations consumed after resolution.
 */
/**
 * Serialize a resolved package into the registry-cache row shape. Facet task
 * bodies keep inline literals of this shape because `fn.toString()` isolates
 * cannot import supervisor modules.
 */
export function registryEntryFromResolved(pkg) {
    return {
        name: pkg.name,
        version: pkg.version,
        tarballUrl: pkg.tarballUrl,
        integrity: pkg.integrity,
        depsJson: JSON.stringify(pkg.dependencies),
        peerDepsJson: JSON.stringify(pkg.peerDependencies ?? {}),
        exportsJson: JSON.stringify(pkg.exports ?? {}),
        main: pkg.main,
        moduleField: pkg.module,
        binJson: JSON.stringify(pkg.bin),
        platformJson: JSON.stringify({ os: pkg.os, cpu: pkg.cpu, libc: pkg.libc }),
        optionalDepsJson: JSON.stringify(pkg.optionalDependencies ?? {}),
        fetchedAt: Date.now(),
    };
}
/** Compute the flat hoist plan used by the current one-version-per-name resolver. */
export function computeHoistPlan(resolved) {
    return {
        root: new Map(resolved),
        nested: new Map(),
    };
}
