// The staged napi bindings users' installs need, and those no build provides.
//
// A staged binding loads only under its owner at the version it was built
// from (packages/worker/src/runtime/staged-bindings.ts), and the version a
// project installs is not ours to pick: `npm create astro` installs the
// latest astro, whose ranges npm resolves to the newest published versions.
// So the versions in demand are those ranges resolved, along each chain
// from a consumer to a binding's owner (DEMAND), and a release whose
// bindings miss one breaks every new project of that consumer
// (scripts/ci/release.mjs refuses it).

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
];

/** The registry's install metadata for a package (dist-tags, and each version's dependencies). */
export async function npmPackument(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!response.ok) throw new Error(`npm registry: ${name}: HTTP ${response.status}`);
  return response.json();
}

/** The newest published version satisfying `range`, prereleases only where the range names one, as npm picks it. */
function newest(packument, range) {
  let best = null;
  for (const version of Object.keys(packument.versions ?? {})) {
    if (version.includes('-') && !range.includes('-')) continue;
    if (!Bun.semver.satisfies(version, range)) continue;
    if (best === null || Bun.semver.order(version, best) > 0) best = version;
  }
  return best;
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
  const packuments = new Map();
  const read = (name) => {
    if (!packuments.has(name)) packuments.set(name, packument(name));
    return packuments.get(name);
  };
  const demanded = new Map();
  for (const chain of demand) {
    const [root, ...rest] = chain;
    let version = (await read(root))['dist-tags']?.latest;
    if (!version) throw new Error(`binding demand: ${root} has no latest release`);
    const via = [`${root}@${version}`];
    let from = root;
    for (const next of rest) {
      const manifest = (await read(from)).versions?.[version] ?? {};
      const range = manifest.dependencies?.[next] ?? manifest.optionalDependencies?.[next];
      if (range === undefined) throw new Error(`binding demand: ${from}@${version} does not depend on ${next}; update DEMAND in scripts/ci/lib/binding-demand.mjs`);
      version = newest(await read(next), range);
      if (version === null) throw new Error(`binding demand: no published ${next} satisfies ${via.at(-1)}'s ${range}`);
      via.push(`${next}@${version}`);
      from = next;
    }
    const owner = chain.at(-1);
    const name = owners.get(owner);
    if (name === undefined) throw new Error(`binding demand: DEMAND ends at ${owner}, which no staged binding owns`);
    const key = `${name}@${version}`;
    if (!demanded.has(key)) demanded.set(key, { key, owner, version, via, built: key in specs });
  }
  const all = [...demanded.values()];
  return { demanded: all, missing: all.filter((d) => !d.built) };
}
