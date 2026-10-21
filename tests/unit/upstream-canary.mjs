#!/usr/bin/env bun
// The daily upstream canary names what changed upstream since its last green
// run (scripts/ci/lib/upstream.mjs):
//   - resolveInstalls: what a fresh install of each probe's recorded
//     package.json takes, by the rules Nimbus's npm installs by. Its roots
//     as npm takes them (a dev range over a dependency's), each at the
//     version its range admits, and
//     below them each dependency, required peer and optional dependency;
//     a staged binding's owner at the newest staged version its range
//     admits; an npm: alias as the package it names. An optional peer is
//     not installed; a git dependency comes from no registry. The package
//     ABI policy shapes the tree as the installer does: lightningcss
//     installs as lightningcss-wasm; rollup 4 as @rollup/wasm-node only at
//     the version rollup's own range picks, where wasm-node publishes it;
//     a staged binding's owner installs without its optional dependencies;
//     an optional native shard is left out, unless it is a staged binding,
//     whose rewrite clears its platform fields first.
//   - upstreamChanges: per install, each package whose versions differ from
//     the last green run's, and nothing else; an install with no record
//     there is null, not a list of every package it takes.
import assert from 'node:assert/strict';
import { resolveInstalls, upstreamChanges } from '../../scripts/ci/lib/upstream.mjs';

const pkg = (latest, versions) => ({ 'dist-tags': { latest }, versions });
/** A registry of `packages`, counting each packument read: one per package for the whole run. */
const registry = (packages) => {
  const reads = new Map();
  return {
    reads,
    packument: async (name) => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      if (!(name in packages)) throw new Error(`no package ${name}`);
      return packages[name];
    },
  };
};
const SPECS = { 'rolldown@1.2.13': { name: 'rolldown', version: '1.2.13', npm: { owner: 'rolldown' } } };
const packages = {
  vite: pkg('8.3.5', {
    '8.3.4': { dependencies: { rolldown: '~1.2.12', picomatch: '^4.0.0' } },
    '8.3.5': { dependencies: { rolldown: '~1.2.12', picomatch: '^4.0.0', fork: 'npm:@scope/fork@^2.0.0', lightningcss: '^1.30.0' }, peerDependencies: { less: '*', yaml: '^2.0.0' }, peerDependenciesMeta: { less: { optional: true } } },
  }),
  rolldown: pkg('1.2.14', { '1.2.12': {}, '1.2.13': { optionalDependencies: { '@rolldown/binding-linux-x64-gnu': '1.2.13' } }, '1.2.14': {} }),
  picomatch: pkg('4.0.3', { '4.0.2': {}, '4.0.3': { optionalDependencies: { fsevents: '^2.3.0', 'tiny-opt': '^1.0.0' } }, '5.0.0': {} }),
  fsevents: pkg('2.3.3', { '2.3.3': { os: ['darwin'] } }),
  'tiny-opt': pkg('1.0.0', { '1.0.0': {} }),
  'lightningcss-wasm': pkg('1.30.2', { '1.30.2': {} }),
  '@scope/fork': pkg('2.1.0', { '2.1.0': { dependencies: { vite: '^8.0.0' }, optionalDependencies: { '@rolldown/binding-wasm32-wasi': '1.2.13' } } }),
  '@rolldown/binding-wasm32-wasi': pkg('1.2.13', { '1.2.13': { cpu: ['wasm32'] } }),
  yaml: pkg('2.8.0', { '1.10.2': {}, '2.8.0': {} }),
  less: pkg('4.4.0', { '4.4.0': {} }),
  astro: pkg('7.4.2', { '7.4.1': {}, '7.4.2': { dependencies: { vite: '^8.3.0', 'git-dep': 'github:someone/git-dep' } } }),
  rollup: pkg('4.63.5', { '3.29.5': {}, '4.63.4': {}, '4.63.5': {} }),
  '@rollup/wasm-node': pkg('4.63.4', { '4.63.4': {} }),
};

// ── each probe's install, by the rules Nimbus's npm installs by ──
{
  const { reads, packument } = registry(packages);
  const installs = await resolveInstalls({
    'frameworks/vite8-real': { devDependencies: { vite: '^8.3.0' } },
    'frameworks/astro-real': { dependencies: { astro: '^7.4.0' } },
    rollups: { dependencies: { rollup: '^4.0.0', old: 'npm:rollup@^3.0.0', pinned: 'npm:rollup@4.63.4' } },
  }, { specs: SPECS, packument });
  const vite = {
    '@rolldown/binding-wasm32-wasi': ['1.2.13'],
    '@scope/fork': ['2.1.0'],
    'lightningcss-wasm': ['1.30.2'],
    picomatch: ['4.0.3'],
    rolldown: ['1.2.13'],
    'tiny-opt': ['1.0.0'],
    vite: ['8.3.5'],
    yaml: ['2.8.0'],
  };
  assert.deepEqual(installs, {
    'frameworks/vite8-real': vite,
    'frameworks/astro-real': { ...vite, astro: ['7.4.2'] },
    rollups: { '@rollup/wasm-node': ['4.63.4'], rollup: ['3.29.5', '4.63.5'] },
  });
  assert.deepEqual(Object.keys(installs['frameworks/vite8-real']), Object.keys(installs['frameworks/vite8-real']).sort(), 'packages in name order: one record, one text');
  assert.ok([...reads.values()].every((count) => count === 1), `each packument is read once for every install: ${JSON.stringify([...reads])}`);
  assert.equal(reads.has('less'), false, 'an optional peer is not installed');
  assert.equal(reads.has('lightningcss'), false, 'a swapped package is read as its target');
  assert.equal(reads.has('@rolldown/binding-linux-x64-gnu'), false, "a staged binding's native optional dependencies are not followed");
}

// ── a root named in dependencies and devDependencies installs at its dev range, as npm's roots take it (projectRoots) ──
{
  const installs = await resolveInstalls({ app: { dependencies: { yaml: '^1.0.0' }, devDependencies: { yaml: '^2.0.0' } } }, { specs: SPECS, packument: registry(packages).packument });
  assert.deepEqual(installs.app, { yaml: ['2.8.0'] });
}

// ── a package the install takes in two versions keeps both ──
{
  const two = structuredClone(packages);
  two.astro.versions['7.4.2'].dependencies.rolldown = '1.2.12';
  const installs = await resolveInstalls({ 'frameworks/astro-real': { dependencies: { astro: '^7.4.0' } } }, { specs: SPECS, packument: registry(two).packument });
  assert.deepEqual(installs['frameworks/astro-real'].rolldown, ['1.2.12', '1.2.13']);
}

// ── what changed since the last green run, and only that ──
{
  const before = {
    'frameworks/vite8-real': { vite: ['8.3.4'], rolldown: ['1.2.13'], picomatch: ['4.0.3'], tinyglobby: ['0.2.15'] },
    'frameworks/astro-real': { astro: ['7.4.1'], vite: ['8.3.4'] },
  };
  const after = {
    'frameworks/vite8-real': { vite: ['8.3.5'], rolldown: ['1.2.13', '1.2.14'], picomatch: ['4.0.3'], fdir: ['6.5.0'] },
    'frameworks/astro-real': { astro: ['7.4.1'], vite: ['8.3.4'] },
    'frameworks/nextjs-real': { next: ['16.1.0'] },
  };
  assert.deepEqual(upstreamChanges(before, after), {
    'frameworks/vite8-real': [
      { name: 'fdir', before: [], after: ['6.5.0'] },
      { name: 'rolldown', before: ['1.2.13'], after: ['1.2.13', '1.2.14'] },
      { name: 'tinyglobby', before: ['0.2.15'], after: [] },
      { name: 'vite', before: ['8.3.4'], after: ['8.3.5'] },
    ],
    'frameworks/astro-real': [],
    'frameworks/nextjs-real': null,
  });
}

console.log('upstream-canary: ok');
