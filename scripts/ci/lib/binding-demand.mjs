// The staged napi bindings users' installs need, and those no build provides.
//
// A staged binding loads only under its owner at the version it was built
// from (packages/worker/src/runtime/staged-bindings.ts). Nimbus's npm installs
// an owner at the newest staged version its range admits
// (worker/src/npm/resolve-one-facet.ts stagedBindingVersion), but a range
// that admits none (@astrojs/compiler-rs pins compiler-binding exactly)
// installs what any other package would, which will not load. So along each
// chain from a consumer users install by name to a binding's owner (DEMAND),
// from the consumer's latest release, each edge resolves by that resolver's
// own rule (core npm-semver.ts pickInstalledVersion, npm-tree.ts
// manifestEdges), and an owner the chain lands on unstaged breaks every new
// project of that consumer (scripts/ci/release.mjs refuses it).

import { pickInstalledVersion } from '../../../packages/core/src/_shared/npm-semver.ts';
import { parseRegistryRequest } from '../../../packages/core/src/_shared/npm-spec.ts';
import { manifestEdges } from '../../../packages/core/src/_shared/npm-tree.ts';
import { SPECS } from '../../../packages/worker/scripts/napi-wasm/specs.mjs';

/**
 * Each chain runs from a consumer users install by name to a staged
 * binding's owner, by declared dependency. Every staged owner ends one, and a
 * chain a consumer no longer declares is an error: this table follows them.
 */
export const DEMAND = [
  ['astro', '@astrojs/compiler-rs', '@astrojs/compiler-binding'],
  ['astro', '@astrojs/markdown-satteri', 'satteri'],
  ['astro', 'rolldown'],
  ['vite', 'rolldown'],
  ['@tailwindcss/vite', '@tailwindcss/oxide'],
  ['@tailwindcss/postcss', '@tailwindcss/oxide'],
  ['@tailwindcss/cli', '@tailwindcss/oxide'],
];

/** The registry's install metadata for a package (dist-tags, and each version's dependencies). */
export async function npmPackument(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!response.ok) throw new Error(`npm registry: ${name}: HTTP ${response.status}`);
  return response.json();
}

/** `packument`, read at most once per package. */
export function readOnce(packument) {
  const packuments = new Map();
  return (name) => {
    if (!packuments.has(name)) packuments.set(name, packument(name));
    return packuments.get(name);
  };
}

/** The versions staged for an owner. */
function stagedVersions(specs, owner) {
  return Object.values(specs).filter((spec) => spec.npm.owner === owner).map((spec) => spec.version);
}

/**
 * The version Nimbus's npm installs for a registry request (core
 * parseRegistryRequest), read from its packument by `read`: a staged
 * binding owner's newest staged version the range admits, else what any
 * package would get (core pickInstalledVersion). Null when no published
 * version answers.
 */
export async function installedVersion(request, { read, specs }) {
  const packument = await read(request.registryName);
  return pickInstalledVersion(packument.versions, packument['dist-tags'], request.range, stagedVersions(specs, request.registryName));
}

/**
 * Each owner version DEMAND's chains resolve to (`demanded`, with its chain
 * and its build's key), and those no spec builds (`missing`, keyed as the
 * build to make). Throws where a chain no longer holds or a staged owner
 * ends none.
 */
export async function missingBindings({ specs = SPECS, demand = DEMAND, packument = npmPackument } = {}) {
  const owners = new Map();
  for (const spec of Object.values(specs)) owners.set(spec.npm.owner, spec.name);
  for (const [owner, name] of owners) {
    if (!demand.some((chain) => chain.at(-1) === owner)) throw new Error(`binding demand: staged binding ${name} (${owner}) ends no chain in DEMAND`);
  }
  const read = readOnce(packument);
  const demanded = new Map();
  for (const chain of demand) {
    const [root, ...rest] = chain;
    const consumer = await read(root);
    let version = pickInstalledVersion(consumer.versions, consumer['dist-tags'], 'latest');
    if (version === null) throw new Error(`binding demand: ${root} has no latest release`);
    const via = [`${root}@${version}`];
    let from = root;
    for (const next of rest) {
      const edge = manifestEdges((await read(from)).versions?.[version] ?? {}).find((e) => e.name === next && e.type !== 'peer' && e.type !== 'peerOptional');
      if (edge === undefined) throw new Error(`binding demand: ${from}@${version} does not depend on ${next}; update DEMAND in scripts/ci/lib/binding-demand.mjs`);
      const request = parseRegistryRequest(next, edge.range);
      version = await installedVersion(request, { read, specs });
      if (version === null) throw new Error(`binding demand: no published ${request.registryName} answers ${via.at(-1)}'s ${edge.range}`);
      via.push(`${request.registryName}@${version}`);
      from = request.registryName;
    }
    if (!owners.has(chain.at(-1))) throw new Error(`binding demand: DEMAND ends at ${chain.at(-1)}, which no staged binding owns`);
    // What installs is the package the walk resolved: an alias to another
    // package installs that one, under which no staged binding loads, and no
    // build makes one; its spec, or DEMAND, is what to update.
    const owner = from;
    const name = owners.get(owner);
    if (name === undefined) throw new Error(`binding demand: ${via.join(' > ')} installs ${owner}, which no staged binding owns; add its spec to packages/worker/scripts/napi-wasm/specs.mjs or update DEMAND`);
    const key = `${name}@${version}`;
    if (!demanded.has(key)) demanded.set(key, { key, owner, version, via, built: key in specs });
  }
  const all = [...demanded.values()];
  return { demanded: all, missing: all.filter((d) => !d.built) };
}
