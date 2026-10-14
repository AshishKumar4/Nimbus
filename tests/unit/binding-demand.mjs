#!/usr/bin/env bun
// A release names every staged napi binding its users' installs need and no
// build provides. What a user installs is what npm resolves from the
// consumers' latest releases: each declared range to its newest published
// version (no prerelease), along each chain from a consumer to a binding's
// owner. A chain that no longer holds, or a staged binding no chain
// reaches, is an error naming what to update, never a silent pass.
import assert from 'node:assert/strict';
import { missingBindings } from '../../scripts/ci/lib/binding-demand.mjs';

const pkg = (latest, versions) => ({ 'dist-tags': { latest }, versions });
const registry = (packages) => async (name) => {
  if (!(name in packages)) throw new Error(`no package ${name}`);
  return packages[name];
};
const spec = (name, owner, version) => [`${name}@${version}`, { name, version, npm: { owner } }];
const SPECS = Object.fromEntries([
  spec('astro-compiler', '@astrojs/compiler-binding', '0.5.1'),
  spec('astro-compiler', '@astrojs/compiler-binding', '0.5.2'),
  spec('rolldown', 'rolldown', '1.2.13'),
]);
const DEMAND = [
  ['astro', '@astrojs/compiler-rs', '@astrojs/compiler-binding'],
  ['astro', 'rolldown'],
  ['vite', 'rolldown'],
];
const packages = {
  astro: pkg('7.3.8', {
    '7.3.8': { dependencies: { '@astrojs/compiler-rs': '^0.5.1', rolldown: '^1.2.11' } },
  }),
  vite: pkg('8.3.4', { '8.3.4': { dependencies: { rolldown: '~1.2.12' } } }),
  '@astrojs/compiler-rs': pkg('0.5.2', {
    '0.5.1': { dependencies: { '@astrojs/compiler-binding': '0.5.1' } },
    '0.5.2': { dependencies: { '@astrojs/compiler-binding': '0.5.2' } },
  }),
  '@astrojs/compiler-binding': pkg('0.5.2', { '0.5.1': {}, '0.5.2': {} }),
  rolldown: pkg('1.2.13', { '1.2.11': {}, '1.2.12': {}, '1.2.13': {} }),
};

// ── every demanded version has a build ──
{
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(packages) });
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.demanded.map((d) => d.key).sort(), ['astro-compiler@0.5.2', 'rolldown@1.2.13']);
}

// ── a patch release the consumer's range takes: named, with its chain and how to build it ──
{
  const newer = structuredClone(packages);
  newer['@astrojs/compiler-rs'].versions['0.5.3'] = { dependencies: { '@astrojs/compiler-binding': '0.5.3' } };
  newer['@astrojs/compiler-binding'].versions['0.5.3'] = {};
  // A prerelease no range takes, and a minor the range excludes.
  newer['@astrojs/compiler-rs'].versions['0.5.4-beta.1'] = { dependencies: { '@astrojs/compiler-binding': '0.5.4-beta.1' } };
  newer['@astrojs/compiler-rs'].versions['0.6.0'] = { dependencies: { '@astrojs/compiler-binding': '0.6.0' } };
  newer.rolldown.versions['1.3.0'] = {};
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(newer) });
  assert.deepEqual(report.missing.map((m) => [m.key, m.via.join(' > ')]), [
    ['astro-compiler@0.5.3', 'astro@7.3.8 > @astrojs/compiler-rs@0.5.3 > @astrojs/compiler-binding@0.5.3'],
    ['rolldown@1.3.0', 'astro@7.3.8 > rolldown@1.3.0'],
  ]);
}

// ── a chain that no longer holds is an error naming it ──
{
  const moved = structuredClone(packages);
  delete moved.astro.versions['7.3.8'].dependencies['@astrojs/compiler-rs'];
  await assert.rejects(
    missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(moved) }),
    /astro@7\.3\.8 does not depend on @astrojs\/compiler-rs/,
  );
}

// ── a staged binding no chain reaches is an error naming it ──
{
  const specs = { ...SPECS, ...Object.fromEntries([spec('satteri', 'satteri', '0.10.5')]) };
  await assert.rejects(
    missingBindings({ specs, demand: DEMAND, packument: registry(packages) }),
    /satteri.*no chain/,
  );
}

console.log('binding-demand: ok');
