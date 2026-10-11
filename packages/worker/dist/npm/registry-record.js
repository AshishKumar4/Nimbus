/**
 * npm/registry-record.ts — one package version's registry metadata as the
 * registry cache keeps it (pkg_registry_cache, npm/cache.ts), and the one
 * codec between it and ResolvedPackage. The resolver facet's task bundles it:
 * a warm hit answers with what a cold resolve of the same version answers,
 * and the writes it stages are the records. The installer checks and
 * reconstructs a lockfile's packages with the same decoder.
 */
/** `json`'s value; `fallback` for none, or one that does not parse. */
function parsed(json, fallback) {
    if (!json)
        return fallback;
    try {
        return JSON.parse(json);
    }
    catch {
        return fallback;
    }
}
/** The record of `pkg`, fetched at `fetchedAt`, as the cache keeps it. */
export function registryRecord(pkg, fetchedAt) {
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
        fetchedAt,
    };
}
/** A record's edges: its dependencies, required peers and optional dependencies. */
export function recordEdges(record) {
    const peers = parsed(record.peerDepsJson, {});
    const optional = parsed(record.optionalDepsJson, {});
    return {
        dependencies: parsed(record.depsJson, {}),
        peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
        optionalDependencies: Object.keys(optional).length > 0 ? optional : undefined,
    };
}
/** The package a record describes, as a cold resolve of its version answers it. */
export function resolvedFromRecord(record) {
    const platform = parsed(record.platformJson, {});
    return {
        name: record.name,
        version: record.version,
        tarballUrl: record.tarballUrl,
        integrity: record.integrity,
        ...recordEdges(record),
        os: Array.isArray(platform.os) ? platform.os : undefined,
        cpu: Array.isArray(platform.cpu) ? platform.cpu : undefined,
        libc: Array.isArray(platform.libc) ? platform.libc : undefined,
        exports: parsed(record.exportsJson, null),
        main: record.main,
        module: record.moduleField,
        bin: parsed(record.binJson, {}),
    };
}
