import { compareSemver, parseSemver } from '../../../packages/core/src/_shared/npm-semver.ts';
import { resolveOnePackumentInFacet } from '../../../packages/worker/src/npm/resolve-one-facet.ts';
import { parseRegistryRequest } from '../../../packages/core/src/_shared/npm-spec.ts';
import './resolve-facet-scope.mjs';

/** @typedef {import('../../../packages/worker/src/npm/resolve-one-facet.ts').ResolveOneSpec} ResolveOneSpec */
/** @typedef {import('../../../packages/worker/src/npm/resolve-one-facet.ts').ResolveOneResult} ResolveOneResult */
/** @typedef {import('../../../packages/worker/src/npm/resolver.ts').ResolvedPackage} ResolvedPackage */
/** @typedef {import('../../../packages/worker/src/npm/registry-record.ts').RegistryCacheEntry} RegistryCacheEntry */
/** @typedef {Partial<Omit<ResolveOneSpec, 'cachedEntries'>> & { cachedEntries?: RegistryCacheEntry[] }} RegistryRequest */
/**
 * @typedef {Partial<Pick<ResolvedPackage, 'dependencies' | 'peerDependencies' | 'peerDependenciesMeta' | 'optionalDependencies' | 'bundleDependencies' | 'engines' | 'os' | 'cpu' | 'libc' | 'main'>> & {
 *   bin?: ResolvedPackage['bin'] | string,
 *   dist?: { tarball?: string, integrity?: string, shasum?: string },
 * }} ManifestFields
 */

/**
 * Published manifests, resolved by the production task through its supervisor seam.
 * @param {Record<string, Record<string, ManifestFields>>} packages
 * @param {{ distTags?: Record<string, Record<string, string>> }} [options]
 */
export function npmRegistry(packages, { distTags = {} } = {}) {
  /** @type {string[]} */
  const asked = [];

  /** @param {string} name */
  const packumentFor = (name) => {
    const versions = packages[name];
    if (!versions) return null;
    const ordered = Object.keys(versions).sort((a, b) => {
      const left = parseSemver(a);
      const right = parseSemver(b);
      if (left === null || right === null) throw new TypeError(`invalid fixture version: ${a}, ${b}`);
      return compareSemver(right, left);
    });
    return {
      name,
      'dist-tags': { latest: ordered[0], ...distTags[name] },
      versions: Object.fromEntries(Object.entries(versions).map(([version, fields]) => [version, {
        name, version, main: 'index.js', ...fields,
        dist: { tarball: `https://registry.invalid/${name}-${version}.tgz`, integrity: `sha512-${name}-${version}`, ...fields.dist },
      }])),
    };
  };

  /** @type {Parameters<typeof resolveOnePackumentInFacet>[1]} */
  const env = {
    SUPERVISOR: {
      async getPackument(name) {
        asked.push(name);
        const packument = packumentFor(name);
        return { json: packument === null ? null : JSON.stringify(packument), source: 'network', events: [], ...(packument === null ? { status: 404 } : {}) };
      },
    },
  };

  /**
   * @param {string} name
   * @param {RegistryRequest} [spec]
   * @returns {Promise<ResolveOneResult>}
   */
  const resultFor = (name, spec = {}) => resolveOnePackumentInFacet({
    name, range: 'latest', cachedEntries: [], fetchTimeoutMs: 1_000, retries: 0,
    registry: 'https://registry.invalid', ...spec,
  }, env);

  return { resultFor, asked, packumentFor };
}

/**
 * A single published version for tests that need no registry graph.
 * @param {string} name
 * @param {string} version
 * @param {ManifestFields} [fields]
 * @param {RegistryRequest} [spec]
 * @returns {Promise<ResolveOneResult>}
 */
export function resolvePackage(name, version, fields = {}, spec = {}) {
  const { registryName } = parseRegistryRequest(name, spec.range ?? 'latest');
  return npmRegistry({ [registryName]: { [version]: fields } }).resultFor(name, spec);
}
