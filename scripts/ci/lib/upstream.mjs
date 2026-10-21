// What the daily upstream canary (scripts/ci/upstream-canary.mjs) runs, and
// how it names what changed upstream since its last green run.
//
// Each probe here installs real frameworks from npm at their latest
// releases, so a new upstream release can break it with no change on our
// side. Each records its project's package.json once it is written
// (tests/behavioral/_driver.mjs projectManifest). The canary resolves what
// that manifest installs from the registry, by the rules Nimbus's npm
// installs by, keeps it with every run, and on a red run names each package
// whose version differs from the last green run's.

import { manifestEdges } from '../../../packages/core/src/_shared/npm-tree.ts';
import { parseRegistryRequest } from '../../../packages/core/src/_shared/npm-spec.ts';
import { SPECS } from '../../../packages/worker/scripts/napi-wasm/specs.mjs';
import { applyStagedArtifact, isOptionalNativeBinding, lookupStagedArtifact, lookupSwap, swapCoversVersion } from '../../../packages/worker/src/facets/wasm-swap-registry.ts';
import { installedVersion, npmPackument, readOnce } from './binding-demand.mjs';

/** The probes the canary runs against production. Each records its project's package.json as `manifest`. */
export const UPSTREAM_PROBES = [
  'frameworks/vite8-real',
  'frameworks/astro-real',
  'frameworks/nextjs-real',
  'frameworks/nuxt-real',
  'frameworks/remix-real',
  'frameworks/vinext-real',
  'frameworks/vite-tailwind4-real',
];

const byVersion = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * The package and version Nimbus's npm installs for a registry request, or
 * null when no published version answers: installedVersion, with the
 * package ABI policy's swap applied as the resolver applies it. A swapped
 * package (lightningcss) installs as its target (lightningcss-wasm). A swap
 * with `since` (rollup) stands in for the version the package's own range
 * picks, where it covers that version and its target publishes it.
 */
async function installedPackage(request, context) {
  const swap = lookupSwap(request.registryName);
  if (swap && !swap.since) {
    const version = await installedVersion({ ...request, registryName: swap.to }, context);
    return version === null ? null : { name: swap.to, version };
  }
  const version = await installedVersion(request, context);
  if (version === null) return null;
  if (swap && swapCoversVersion(swap, version) && (await context.read(swap.to)).versions?.[version] !== undefined) return { name: swap.to, version };
  return { name: request.registryName, version };
}

/**
 * What a fresh install of each probe's manifest takes: { probe: { name:
 * [version, …] } }, names and versions in order. Its dependencies and dev
 * dependencies, and below them each dependency, optional dependency and
 * required peer, are the package and version Nimbus's npm installs
 * (installedPackage); an optional peer is not installed. The package ABI
 * policy shapes the tree as the installer does: a staged artifact installs
 * without its optional dependencies and platform fields, and then an
 * optional native package is left out. A spec no registry answers (git,
 * file, URL), and a range no published version admits, are left out: the
 * probe's own install says why. Every packument is read once for all the
 * probes.
 */
export async function resolveInstalls(manifests, { specs = SPECS, packument = npmPackument } = {}) {
  const context = { read: readOnce(packument), specs };
  const edgesOf = (manifest) => manifestEdges(manifest).filter((edge) => edge.type !== 'peerOptional')
    .map((edge) => ({ request: parseRegistryRequest(edge.name, edge.range), optional: edge.type === 'optional' }));
  const installs = {};
  for (const [probe, manifest] of Object.entries(manifests)) {
    const taken = new Map();
    let wanted = edgesOf({ ...manifest, dependencies: { ...manifest.devDependencies, ...manifest.dependencies } });
    while (wanted.length > 0) {
      const resolved = await Promise.all(wanted.filter(({ request }) => request.registry)
        .map(async ({ request, optional }) => ({ optional, picked: await installedPackage(request, context) })));
      wanted = [];
      for (const { optional, picked } of resolved) {
        if (picked === null || taken.get(picked.name)?.has(picked.version)) continue;
        const shaped = { ...(await context.read(picked.name)).versions?.[picked.version], name: picked.name };
        const staged = lookupStagedArtifact(picked.name);
        if (staged) applyStagedArtifact(shaped, staged);
        if (optional && isOptionalNativeBinding(shaped)) continue;
        taken.set(picked.name, (taken.get(picked.name) ?? new Set()).add(picked.version));
        wanted.push(...edgesOf(shaped));
      }
    }
    installs[probe] = Object.fromEntries([...taken].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, versions]) => [name, [...versions].sort(byVersion)]));
  }
  return installs;
}

/**
 * For each install in `after`, every package whose versions differ from the
 * same install in `before`: { probe: [{ name, before, after }] } by name,
 * each side its versions ([] where it is not installed). Null for an
 * install `before` has no record of.
 */
export function upstreamChanges(before, after) {
  return Object.fromEntries(Object.entries(after).map(([probe, now]) => {
    const then = before[probe];
    if (!then) return [probe, null];
    const names = [...new Set([...Object.keys(then), ...Object.keys(now)])].sort();
    return [probe, names.flatMap((name) => {
      const was = then[name] ?? [];
      const is = now[name] ?? [];
      return was.join() === is.join() ? [] : [{ name, before: was, after: is }];
    })];
  }));
}
