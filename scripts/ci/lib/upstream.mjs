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
import { installedVersion, npmPackument, readOnce } from './binding-demand.mjs';

/**
 * The probes the canary runs against production, each with the packages
 * its project installs by name: the roots of the install it resolves.
 * vite-tailwind4-real pins Tailwind to the staged oxide build, so its roots
 * leave Tailwind out; the binding demand follows Tailwind's latest release.
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
 * What a fresh install of each probe's roots takes: { probe: { name:
 * [version, …] } }, names and versions in order. Each root is at its latest
 * release. Each dependency, optional dependency and required peer is at the
 * version Nimbus's npm installs (installedVersion); an optional peer is not
 * installed. A spec no registry answers (git, file, URL), and a range no
 * published version admits, are left out: the probe's own install says why.
 * Every packument is read once for all the probes.
 */
export async function resolveInstalls(probes, { specs = SPECS, packument = npmPackument } = {}) {
  const read = readOnce(packument);
  const installs = {};
  for (const [probe, roots] of Object.entries(probes)) {
    const taken = new Map();
    let wanted = roots.map((name) => parseRegistryRequest(name, 'latest'));
    while (wanted.length > 0) {
      const resolved = await Promise.all(wanted.filter((request) => request.registry)
        .map(async (request) => ({ name: request.registryName, version: await installedVersion(request, { read, specs }) })));
      wanted = [];
      for (const { name, version } of resolved) {
        if (version === null || taken.get(name)?.has(version)) continue;
        taken.set(name, (taken.get(name) ?? new Set()).add(version));
        const manifest = (await read(name)).versions?.[version] ?? {};
        wanted.push(...manifestEdges(manifest).filter((edge) => edge.type !== 'peerOptional').map((edge) => parseRegistryRequest(edge.name, edge.range)));
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
