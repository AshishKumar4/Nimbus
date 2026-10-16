/**
 * npm/registry-record.ts — one package version's registry metadata as the
 * registry cache keeps it (pkg_registry_cache, npm/cache.ts), and the one
 * codec between it and ResolvedPackage. The resolver facet's task bundles it:
 * a warm hit answers with what a cold resolve of the same version answers,
 * and the writes it stages are the records. The installer checks and
 * reconstructs a lockfile's packages with the same decoder.
 */

import type { ResolvedPackage } from './resolver.js';

export interface RegistryCacheEntry {
  name: string;
  version: string;
  /** The registry package (an alias's target); '' for rows written before it was kept. */
  registryName?: string;
  tarballUrl: string;
  integrity: string;
  depsJson: string;       // JSON-encoded Record<string, string>
  /**
   * JSON-encoded peerDependencies: every peer, the optional ones named by
   * peerMetaJson. Rows written before peerMetaJson was kept hold only the
   * required peers, which read as required. '{}' for rows written before
   * the column existed (added via ALTER TABLE, see ensureSchema).
   */
  peerDepsJson?: string;
  main: string;
  binJson: string;        // JSON-encoded bin field
  /**
   * JSON-encoded npm platform constraints — `{ os?, cpu?, libc? }`.
   *
   * Persisted so warm-cache resolution keeps the same ABI/platform
   * decisions as a cold packument fetch (native-shard silent-skip and
   * platform-native rejects are metadata-driven). '{}' means no
   * constraints; rows written before the column existed read as '{}'
   * (a metadata miss, matching pre-migration behavior).
   */
  platformJson?: string;
  /**
   * JSON-encoded `optionalDependencies`. Persisted so cached parents
   * still enqueue their best-effort optional deps exactly like a cold
   * resolve. Defaults to '{}' for pre-migration rows.
   */
  optionalDepsJson?: string;
  /** JSON-encoded `peerDependenciesMeta` (which peers are optional); '{}' for rows written before it was kept, whose peers are the required ones. */
  peerMetaJson?: string;
  /** JSON-encoded `bundleDependencies` as published; '' for none (and rows written before it was kept). */
  bundleJson?: string;
  /** JSON-encoded `engines` as published; '' for none. */
  enginesJson?: string;
}

// The shapes a record's JSON fields have.
type Platform = { os?: unknown; cpu?: unknown; libc?: unknown };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** `engines` as a manifest states it (a registry's, a lock's): what it asks of each engine. */
export const isEngines: (value: unknown) => value is Readonly<Record<string, unknown>> = isObject;
const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'string');
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isPeerMeta = (value: unknown): value is Record<string, { optional?: boolean }> =>
  isObject(value) && Object.values(value).every((meta) => isObject(meta) && (meta.optional === undefined || typeof meta.optional === 'boolean'));
const isAnyJson = (value: unknown): value is unknown => true;

/**
 * `json`'s value when it has the field's shape (`shape`); `fallback` for
 * none, one that does not parse, or one of another shape (a malformed row
 * reads as an empty one, never as a failure).
 */
function decoded<T>(json: string | undefined, shape: (value: unknown) => value is T, fallback: T): T {
  if (!json) return fallback;
  // Most of a record's maps are empty: no parse for those.
  let value: unknown = {};
  if (json !== '{}') {
    try { value = JSON.parse(json); } catch { return fallback; }
  }
  return shape(value) ? value : fallback;
}

/** A JSON-encoded name → range map; undefined when it names none. */
function ranges(json: string | undefined): Record<string, string> | undefined {
  if (!json || json === '{}') return undefined;
  const map = decoded(json, isStringMap, {});
  return Object.keys(map).length > 0 ? map : undefined;
}

/** The record of `pkg`, as the cache keeps it. */
export function registryRecord(pkg: ResolvedPackage): RegistryCacheEntry {
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

const NO_PLATFORM: Platform = Object.freeze({});

/** The package a record describes, as a cold resolve of its version answers it. */
export function resolvedFromRecord(record: RegistryCacheEntry): ResolvedPackage {
  const platform: Platform = record.platformJson === '{}' ? NO_PLATFORM : decoded(record.platformJson, isObject, NO_PLATFORM);
  const peerMeta = decoded(record.peerMetaJson, isPeerMeta, {});
  const bundle: unknown = record.bundleJson ? decoded(record.bundleJson, isAnyJson, undefined) : undefined;
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
