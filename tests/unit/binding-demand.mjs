#!/usr/bin/env bun
// A release names every staged napi binding its users' installs need and no
// build provides. What a user installs is what Nimbus's npm resolves from the
// consumers' latest releases, along each chain from a consumer to a
// binding's owner: each declared range to its newest published version (no
// prerelease), but a binding owner's range to the newest staged version it
// admits (resolve-one-facet's stagedBindingVersion). Only a range that admits
// no staged version is missing a build, and at the newest version it admits.
// A chain that no longer holds, or a staged binding no chain reaches, is an
// error naming what to update, never a silent pass.
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
  // A newer rolldown each range admits: the staged 1.2.13 is what installs.
  newer.rolldown.versions['1.2.14'] = {};
  newer.rolldown.versions['1.3.0'] = {};
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(newer) });
  assert.deepEqual(report.missing.map((m) => [m.key, m.via.join(' > ')]), [
    ['astro-compiler@0.5.3', 'astro@7.3.8 > @astrojs/compiler-rs@0.5.3 > @astrojs/compiler-binding@0.5.3'],
  ]);
  assert.deepEqual(report.demanded.filter((d) => d.owner === 'rolldown').map((d) => [d.key, d.built]), [['rolldown@1.2.13', true]]);
}

// ── a range that admits no staged version: missing, at the newest it admits ──
{
  const moved = structuredClone(packages);
  moved.vite.versions['8.4.0'] = { dependencies: { rolldown: '~1.3.0' } };
  moved.vite['dist-tags'].latest = '8.4.0';
  moved.rolldown.versions['1.3.0'] = {};
  moved.rolldown.versions['1.3.1'] = {};
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(moved) });
  assert.deepEqual(report.missing.map((m) => [m.key, m.via.join(' > ')]), [['rolldown@1.3.1', 'vite@8.4.0 > rolldown@1.3.1']]);
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

// ── an open range takes the dist-tag, not the highest published ──
{
  const tagged = structuredClone(packages);
  // A 0.6.0 published but not tagged latest: compiler-rs `latest` installs 0.5.2.
  tagged.astro.versions['7.3.8'].dependencies['@astrojs/compiler-rs'] = 'latest';
  tagged['@astrojs/compiler-rs'].versions['0.6.0'] = { dependencies: { '@astrojs/compiler-binding': '0.6.0' } };
  tagged['@astrojs/compiler-binding'].versions['0.6.0'] = {};
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(tagged) });
  assert.deepEqual(report.missing, [], JSON.stringify(report.missing));
}

// ── an optional dependency of the same name is the one installed ──
{
  const optional = structuredClone(packages);
  optional['@astrojs/compiler-rs'].versions['0.5.2'].optionalDependencies = { '@astrojs/compiler-binding': '0.5.3' };
  optional['@astrojs/compiler-binding'].versions['0.5.3'] = {};
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(optional) });
  assert.deepEqual(report.missing.map((m) => m.key), ['astro-compiler@0.5.3']);
}

// ── an alias to another package installs that package, which no build serves ──
{
  const aliased = structuredClone(packages);
  aliased.vite.versions['8.3.4'].dependencies.rolldown = 'npm:@rolldown/fork@^1.2.12';
  aliased['@rolldown/fork'] = { 'dist-tags': { latest: '1.2.13' }, versions: { '1.2.13': {} } };
  const report = await missingBindings({ specs: SPECS, demand: DEMAND, packument: registry(aliased) });
  assert.deepEqual(report.missing.map((m) => [m.key, m.via.join(' > ')]), [['@rolldown/fork@1.2.13', 'vite@8.3.4 > @rolldown/fork@1.2.13']]);
}

console.log('binding-demand: ok');
