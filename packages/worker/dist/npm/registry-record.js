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
    // Most of a record's maps are empty: no parse for those.
    if (json === '{}')
        return {};
    try {
        return JSON.parse(json);
    }
    catch {
        return fallback;
    }
}
/** A JSON-encoded name → range map; undefined when it names none. */
function ranges(json) {
    if (!json || json === '{}')
        return undefined;
    const map = parsed(json, {});
    return Object.keys(map).length > 0 ? map : undefined;
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
/** A record's edges, as resolvedFromRecord decodes them: its dependencies, required peers and optional dependencies. */
export function recordEdges(record) {
    return {
        dependencies: parsed(record.depsJson, {}),
        peerDependencies: ranges(record.peerDepsJson),
        optionalDependencies: ranges(record.optionalDepsJson),
    };
}
const NO_PLATFORM = Object.freeze({});
/** The package a record describes, as a cold resolve of its version answers it. */
export function resolvedFromRecord(record) {
    const platform = record.platformJson === '{}' ? NO_PLATFORM
        : parsed(record.platformJson, NO_PLATFORM);
    return {
        name: record.name,
        version: record.version,
        tarballUrl: record.tarballUrl,
        integrity: record.integrity,
        dependencies: parsed(record.depsJson, {}),
        peerDependencies: ranges(record.peerDepsJson),
        optionalDependencies: ranges(record.optionalDepsJson),
        os: Array.isArray(platform.os) ? platform.os : undefined,
        cpu: Array.isArray(platform.cpu) ? platform.cpu : undefined,
        libc: Array.isArray(platform.libc) ? platform.libc : undefined,
        exports: parsed(record.exportsJson, null),
        main: record.main,
        module: record.moduleField,
        bin: parsed(record.binJson, {}),
    };
}
