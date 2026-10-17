/**
 * npm/registry-record.ts — one package version's registry metadata as the
 * registry cache keeps it (pkg_registry_cache, npm/cache.ts), and the one
 * codec between it and ResolvedPackage. The resolver facet's task bundles it:
 * a warm hit answers with what a cold resolve of the same version answers,
 * and the writes it stages are the records. The installer checks and
 * reconstructs a lockfile's packages with the same decoder.
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** `engines` as a manifest states it (a registry's, a lock's): what it asks of each engine. */
export const isEngines = isObject;
const isStringMap = (value) => isObject(value) && Object.values(value).every((v) => typeof v === 'string');
const isStringList = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isPeerMeta = (value) => isObject(value) && Object.values(value).every((meta) => isObject(meta) && (meta.optional === undefined || typeof meta.optional === 'boolean'));
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
    let value = {};
    if (json !== '{}') {
        try {
            value = JSON.parse(json);
        }
        catch {
            return fallback;
        }
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
/** The record of `pkg`, as the cache keeps it. */
export function registryRecord(pkg) {
    return {
        name: pkg.name,
        version: pkg.version,
        registryName: pkg.registryName ?? pkg.name,
        tarballUrl: pkg.tarballUrl,
        integrity: pkg.integrity,
        depsJson: JSON.stringify(pkg.dependencies),
        peerDepsJson: JSON.stringify(pkg.peerDependencies ?? {}),
        main: pkg.main,
        binJson: JSON.stringify(pkg.bin),
        platformJson: JSON.stringify({ os: pkg.os, cpu: pkg.cpu, libc: pkg.libc }),
        optionalDepsJson: JSON.stringify(pkg.optionalDependencies ?? {}),
        peerMetaJson: JSON.stringify(pkg.peerDependenciesMeta ?? {}),
        bundleJson: pkg.bundleDependencies === undefined ? '' : JSON.stringify(pkg.bundleDependencies),
        enginesJson: pkg.engines === undefined ? '' : JSON.stringify(pkg.engines),
    };
}
const NO_PLATFORM = Object.freeze({});
/** The package a record describes, as a cold resolve of its version answers it. */
export function resolvedFromRecord(record) {
    const platform = record.platformJson === '{}' ? NO_PLATFORM : decoded(record.platformJson, isObject, NO_PLATFORM);
    const peerMeta = decoded(record.peerMetaJson, isPeerMeta, {});
    const bundle = record.bundleJson ? decoded(record.bundleJson, isAnyJson, undefined) : undefined;
    const engines = record.enginesJson ? decoded(record.enginesJson, isEngines, undefined) : undefined;
    return {
        name: record.name,
        version: record.version,
        ...(record.registryName ? { registryName: record.registryName } : {}),
        tarballUrl: record.tarballUrl,
        integrity: record.integrity,
        dependencies: decoded(record.depsJson, isStringMap, {}),
        peerDependencies: ranges(record.peerDepsJson),
        ...(Object.keys(peerMeta).length > 0 ? { peerDependenciesMeta: peerMeta } : {}),
        ...(bundle === undefined ? {} : { bundleDependencies: bundle }),
        optionalDependencies: ranges(record.optionalDepsJson),
        os: isStringList(platform.os) ? platform.os : undefined,
        cpu: isStringList(platform.cpu) ? platform.cpu : undefined,
        libc: isStringList(platform.libc) ? platform.libc : undefined,
        ...(engines === undefined ? {} : { engines }),
        main: record.main,
        bin: decoded(record.binJson, isStringMap, {}),
    };
}
