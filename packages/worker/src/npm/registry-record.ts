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
  tarballUrl: string;
  integrity: string;
  depsJson: string;       // JSON-encoded Record<string, string>
  /**
   * JSON-encoded REQUIRED peerDependencies (X.5-F R2).
   *
   * Optional peers — those marked `peerDependenciesMeta.<name>.optional
   * === true` in the source packument — are filtered out before this
   * field is written. Storing only the required subset means downstream
   * lockfile-validity checks can ask "is this peer in the tree?"
   * without having to consult the meta field again.
   *
   * Defaults to '{}' for entries written by pre-X.5-F builds (the
   * column was added via ALTER TABLE, see ensureSchema).
   */
  peerDepsJson?: string;
  exportsJson: string;    // JSON-encoded exports field
  main: string;
  moduleField: string;
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
  fetchedAt: number;
}

/** `json`'s value; `fallback` for none, or one that does not parse. */
function parsed<T>(json: string | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

/** The record of `pkg`, fetched at `fetchedAt`, as the cache keeps it. */
export function registryRecord(pkg: ResolvedPackage, fetchedAt: number): RegistryCacheEntry {
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
export function recordEdges(record: RegistryCacheEntry): Pick<ResolvedPackage, 'dependencies' | 'peerDependencies' | 'optionalDependencies'> {
  const peers = parsed<Record<string, string>>(record.peerDepsJson, {});
  const optional = parsed<Record<string, string>>(record.optionalDepsJson, {});
  return {
    dependencies: parsed<Record<string, string>>(record.depsJson, {}),
    peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
    optionalDependencies: Object.keys(optional).length > 0 ? optional : undefined,
  };
}

/** The package a record describes, as a cold resolve of its version answers it. */
export function resolvedFromRecord(record: RegistryCacheEntry): ResolvedPackage {
  const platform = parsed<{ os?: unknown; cpu?: unknown; libc?: unknown }>(record.platformJson, {});
  return {
    name: record.name,
    version: record.version,
    tarballUrl: record.tarballUrl,
    integrity: record.integrity,
    ...recordEdges(record),
    os: Array.isArray(platform.os) ? platform.os : undefined,
    cpu: Array.isArray(platform.cpu) ? platform.cpu : undefined,
    libc: Array.isArray(platform.libc) ? platform.libc : undefined,
    exports: parsed<unknown>(record.exportsJson, null),
    main: record.main,
    module: record.moduleField,
    bin: parsed<Record<string, string>>(record.binJson, {}),
  };
}
