// What the daily upstream canary (scripts/ci/upstream-canary.mjs) runs, and
// how it names what changed upstream since its last green run.
//
// Each probe here installs real frameworks from npm at their latest
// releases, so a new upstream release can break it with no change on our
// side. The canary resolves each probe's install from the registry by the
// rules Nimbus's npm installs by, keeps it with every run, and on a red run
// names each package whose version differs from the last green run's.

import { manifestEdges } from '../../../packages/core/src/_shared/npm-tree.ts';
import { parseRegistryRequest } from '../../../packages/core/src/_shared/npm-spec.ts';
import { SPECS } from '../../../packages/worker/scripts/napi-wasm/specs.mjs';
import { applyStagedArtifact, isOptionalNativeBinding, lookupStagedArtifact, lookupSwap } from '../../../packages/worker/src/facets/wasm-swap-registry.ts';
import { installedVersion, npmPackument, readOnce } from './binding-demand.mjs';

/**
 * The probes the canary runs against production, each with the packages
 * its project installs by name: the roots of the install it resolves. The
 * record follows them and what they depend on, not the probe's own install:
 * a scaffold's dev tools that the probe never runs (typescript, oxlint,
 * @types) are not roots. vite-tailwind4-real pins Tailwind to the staged
 * oxide build, so its roots leave Tailwind out; the binding demand follows
 * Tailwind's latest release.
 */
export const UPSTREAM_PROBES = {
  'frameworks/vite8-real': ['create-vite', 'vite', '@vitejs/plugin-react', 'react', 'react-dom'],
  'frameworks/astro-real': ['create-astro', 'astro'],
  'frameworks/nextjs-real': ['create-next-app', 'next', 'react', 'react-dom', 'tailwindcss', '@tailwindcss/postcss'],
  'frameworks/nuxt-real': ['nuxi', 'nuxt', 'vue', 'vue-router'],
  'frameworks/remix-real': ['create-react-router', 'react-router', '@react-router/dev', '@react-router/node', '@react-router/serve', 'react', 'react-dom', 'vite'],
  'frameworks/vinext-real': ['vinext', 'vite', 'react', 'react-dom', '@vitejs/plugin-rsc', '@vitejs/plugin-react', 'react-server-dom-webpack'],
  'frameworks/vite-tailwind4-real': ['create-vite', 'vite', '@vitejs/plugin-react', 'react', 'react-dom'],
};

const byVersion = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * The package and version Nimbus's npm installs for a registry request, or
 * null when no published version answers: installedVersion, with the
 * package ABI policy's swap applied as the resolver applies it. A swapped
 * package (lightningcss) installs as its target (lightningcss-wasm); a swap
 * with `since` only where the target has a version the range picks.
 */
async function installedPackage(request, context) {
  const swap = lookupSwap(request.registryName);
  if (swap) {
    const version = await installedVersion({ ...request, registryName: swap.to }, context);
    if (version !== null) return { name: swap.to, version };
    if (!swap.since) return null;
  }
  const version = await installedVersion(request, context);
  return version === null ? null : { name: request.registryName, version };
}

/**
 * What a fresh install of each probe's roots takes: { probe: { name:
 * [version, …] } }, names and versions in order. Each root is at its latest
 * release. Each dependency, optional dependency and required peer is the
 * package and version Nimbus's npm installs (installedPackage); an optional
 * peer is not installed. The package ABI policy shapes the tree as the
 * installer does: an optional native shard is left out, and a staged
 * artifact installs without its optional dependencies. A spec no registry
 * answers (git, file, URL), and a range no published version admits, are
 * left out: the probe's own install says why. Every packument is read once
 * for all the probes.
 */
export async function resolveInstalls(probes, { specs = SPECS, packument = npmPackument } = {}) {
  const context = { read: readOnce(packument), specs };
  const edgesOf = (manifest) => manifestEdges(manifest).filter((edge) => edge.type !== 'peerOptional')
    .map((edge) => ({ request: parseRegistryRequest(edge.name, edge.range), optional: edge.type === 'optional' }));
  const installs = {};
  for (const [probe, roots] of Object.entries(probes)) {
    const taken = new Map();
    let wanted = roots.map((name) => ({ request: parseRegistryRequest(name, 'latest'), optional: false }));
    while (wanted.length > 0) {
      const resolved = await Promise.all(wanted.filter(({ request }) => request.registry)
        .map(async ({ request, optional }) => ({ optional, picked: await installedPackage(request, context) })));
      wanted = [];
      for (const { optional, picked } of resolved) {
        if (picked === null || taken.get(picked.name)?.has(picked.version)) continue;
        const manifest = { ...(await context.read(picked.name)).versions?.[picked.version], name: picked.name };
        if (optional && isOptionalNativeBinding(manifest)) continue;
        taken.set(picked.name, (taken.get(picked.name) ?? new Set()).add(picked.version));
        const staged = lookupStagedArtifact(picked.name);
        if (staged) applyStagedArtifact(manifest, staged);
        wanted.push(...edgesOf(manifest));
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
