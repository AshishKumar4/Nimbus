#!/usr/bin/env bun
// An `@source` path is never brace-expanded (Kinu ask 68): the plan takes
// where it can reach, linearly in its length (sourceReach), so a stylesheet
// an agent writes cannot cost the isolate. Before, each path went through
// `braces` with no range limit: `src/{1..100000000}/x.html` (25 characters)
// ran an isolate out of memory, and `{` nested 4,999 deep (9,998 characters)
// overflowed its stack, and `braces` (advisory GHSA-vfj7-8cjw-p6xm, no fixed
// version) was in the worker's dependencies.
//   - the reach is the part before the first glob character, to its last
//     `/`: exact for braces in the file part (`src/**/*.{html,js}`), a
//     superset for braces in the directory part;
//   - a `..` its alternatives could spell climbs a directory, so the reach
//     still covers `{../a,../b}/x`; a range spells no dot;
//   - Kinu's two paths each answer in bounded time, and the sheet's other
//     sources are still held.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as dataPlan from '../../packages/worker/src/facets/data-plan.ts';

const { planStylesheetSources } = dataPlan;
const sourceReach = (path) => {
  if (typeof dataPlan.sourceReach !== 'function') throw new Error('no sourceReach');
  return dataPlan.sourceReach(path);
};

const failures = [];
const check = (name, body) => {
  try {
    body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

check('the part before the first glob character', () => {
  assert.equal(sourceReach('src/**/*.{html,js}'), 'src');
  assert.equal(sourceReach('../kit/**/*.{ts,tsx}'), '../kit');
  assert.equal(sourceReach('../shared'), '../shared', 'no glob: the path itself');
  assert.equal(sourceReach('*.tsx'), '.');
  assert.equal(sourceReach('/{a,b}/x'), '/');
  assert.equal(sourceReach('/home/user/app/../linked/**'), '/home/user/app/../linked');
  assert.equal(sourceReach('../{kit,app}/**/*.tsx'), '..', 'braces in the directory part: their parent');
  assert.equal(sourceReach('../range/{1..1001}.tsx'), '../range');
});

check('a `..` an alternative could spell', () => {
  assert.equal(sourceReach('{../a,../b}/x.html'), './../..', 'each pair of dots a group holds may climb');
  assert.equal(sourceReach('.{,x}./y'), './..', 'dots an empty alternative brings together');
  assert.equal(sourceReach('lib/{a.b,c}/x'), 'lib', 'one dot climbs nothing');
  assert.equal(sourceReach('lib/*.min.{js,css}'), 'lib', 'dots parted by what every expansion spells climb nothing');
  assert.equal(sourceReach('lib/{1..9}/{2..4}/x'), 'lib', 'a range spells no dot');
});

check("Kinu's paths, in bounded time", () => {
  const nested = '{'.repeat(4999) + '}'.repeat(4999);
  const commas = '{a,'.repeat(1999) + '}'.repeat(1999);
  const range = 'src/{1..100000000}/x.html';
  const started = performance.now();
  assert.equal(sourceReach(nested), '.');
  assert.equal(sourceReach(commas), '.');
  assert.equal(sourceReach(range), 'src');
  assert.equal(sourceReach('{'.repeat(200_000) + '.'.repeat(4)), './../..', 'any depth, without recursion');
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

check('the worker depends on no braces', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../packages/worker/package.json', import.meta.url), 'utf8'));
  const named = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies, ...manifest.devDependencies });
  assert.deepEqual(named.filter((name) => /braces/.test(name)), []);
});

// The plan over a sheet holding both of Kinu's paths and a source of its own.
{
  const files = {
    'home/user/app/src/index.css': [
      '@import "tailwindcss";',
      `@source "${'{'.repeat(4999) + '}'.repeat(4999)}";`,
      '@source "../../huge/{1..100000000}/x.html";',
      '@source "../../kit/**/*.{ts,tsx}";',
    ].join('\n'),
    'home/user/kit/Button.tsx': 'b',
    'home/user/huge/1/x.html': 'h',
  };
  const source = {
    readText: async (path) => files[path] ?? null,
    stat: async (path) => {
      if (Object.hasOwn(files, path)) return { kind: 'file', size: files[path].length };
      return Object.keys(files).some((name) => name.startsWith(`${path}/`)) ? { kind: 'directory', size: 0 } : null;
    },
    linkTarget: async () => null,
    readdir: async (dir) => {
      const below = new Map();
      for (const name of Object.keys(files)) {
        if (!name.startsWith(`${dir}/`)) continue;
        const rest = name.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        below.set(rest.slice(0, slash < 0 ? undefined : slash), slash < 0 ? 'file' : 'directory');
      }
      return [...below].map(([name, kind]) => ({ path: `${dir}/${name}`, kind, size: kind === 'file' ? files[`${dir}/${name}`].length : 0 }));
    },
  };
  const started = performance.now();
  let planned = null;
  try {
    planned = await planStylesheetSources(source, { cwd: '/home/user/app', home: '/home/user', sheets: ['home/user/app/src/index.css'] });
  } catch (error) {
    failures.push(`the plan over Kinu's sheet threw: ${error.message}`);
  }
  const ms = performance.now() - started;
  if (planned !== null) {
    const held = planned.files.map((file) => file.path).sort();
    if (!held.includes('home/user/kit/Button.tsx')) failures.push(`the sheet's other source is held: ${JSON.stringify(held)}`);
    if (!held.includes('home/user/huge/1/x.html')) failures.push(`the range's directory is held: ${JSON.stringify(held)}`);
    if (ms > 2000) failures.push(`the plan took ${ms.toFixed(0)} ms`);
  }
}

assert.deepEqual(failures, []);
console.log('data-plan-source-reach: an @source is never expanded; its reach is linear, and a superset');
