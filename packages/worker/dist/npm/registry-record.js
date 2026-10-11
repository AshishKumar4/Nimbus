/**
 * npm/registry-record.ts — one package version's registry metadata as the
 * registry cache keeps it (pkg_registry_cache, npm/cache.ts), and the one
 * codec between it and ResolvedPackage. The resolver facet's task bundles it:
 * a warm hit answers with what a cold resolve of the same version answers,
 * and the writes it stages are the records. The installer checks and
 * reconstructs a lockfile's packages with the same decoder.
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringMap = (value) => isObject(value) && Object.values(value).every((v) => typeof v === 'string');
const isStringList = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isAnyJson = (value) => true;
/**
 * `json`'s value when it has the field's shape (`shape`); `fallback` for
 * none, one that does not parse, or one of another shape (a malformed row
 * reads as an empty one, never as a failure).
 */
function decoded(json, shape, fallback) {
    if (!json)
        return fallback;
    // Most of a record's maps are empty: no parse for those.
    if (json === '{}')
        return {};
    let value;
    try {
        value = JSON.parse(json);
    }
    catch {
        return fallback;
    }
    return shape(value) ? value : fallback;
}
/** A JSON-encoded name → range map; undefined when it names none. */
function ranges(json) {
    if (!json || json === '{}')
        return undefined;
    const map = decoded(json, isStringMap, {});
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
        dependencies: decoded(record.depsJson, isStringMap, {}),
        peerDependencies: ranges(record.peerDepsJson),
        optionalDependencies: ranges(record.optionalDepsJson),
    };
}
const NO_PLATFORM = Object.freeze({});
/** The package a record describes, as a cold resolve of its version answers it. */
export function resolvedFromRecord(record) {
    const platform = record.platformJson === '{}' ? NO_PLATFORM : decoded(record.platformJson, isObject, NO_PLATFORM);
    return {
        name: record.name,
        version: record.version,
        tarballUrl: record.tarballUrl,
        integrity: record.integrity,
        dependencies: decoded(record.depsJson, isStringMap, {}),
        peerDependencies: ranges(record.peerDepsJson),
        optionalDependencies: ranges(record.optionalDepsJson),
        os: isStringList(platform.os) ? platform.os : undefined,
        cpu: isStringList(platform.cpu) ? platform.cpu : undefined,
        libc: isStringList(platform.libc) ? platform.libc : undefined,
        exports: decoded(record.exportsJson, isAnyJson, null),
        main: record.main,
        module: record.moduleField,
        bin: decoded(record.binJson, isStringMap, {}),
    };
}
