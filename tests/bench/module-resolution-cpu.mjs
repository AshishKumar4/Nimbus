#!/usr/bin/env node
// Paired in-process CPU comparison, under V8, of Node's module resolution as
// the runtime answers it (core _shared/esm-resolver.ts createEsmResolver, the
// CommonJS resolver runtime/require-resolution.ts re-exports
// createRequireResolver, and the package maps both select through), one run,
// over an in-memory tree.
// remote-module-resolution-cpu supplies the baseline's tree and judges the
// runs together; each arm is bundled from its side's tree (isolated-core.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { armTree, importBundle, repository } from './lib/isolated-core.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const PAIRS = 30;
const scratch = mkdtempSync(join(tmpdir(), 'module-resolution-cpu-'));
const disposals = [];
let checksum = 0;
const results = [];

/** An arm: the resolvers from its side's tree (`from`), bundled on their own, so no arm shares a module, or its JIT state, with another. */
async function arm(name, from) {
  const tree = armTree(from, (dispose) => disposals.push(dispose));
  const dir = join(tree, 'packages/core/src');
  return importBundle(tree, {
    stdin: {
      contents: `export { createEsmResolver } from ${JSON.stringify(join(dir, '_shared/esm-resolver.ts'))};\n`
        + `export { createRequireResolver } from ${JSON.stringify(join(dir, 'runtime/require-resolution.ts'))};\n`,
      resolveDir: dir, loader: 'ts',
    },
    format: 'esm', platform: 'neutral', target: 'esnext', mainFields: ['module', 'main'],
  }, join(scratch, `${name}.mjs`));
}

// The tree: an application whose package.json has `imports`, and 48
// packages under its node_modules, each with conditional `exports`, a
// pattern subpath and its files; 16 more with a legacy main alone.
const files = new Map();
const dirs = new Set(['/']);
const write = (path, text) => {
  files.set(path, text);
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) dirs.add(path.slice(0, at));
};
write('/app/package.json', JSON.stringify({ name: 'app', type: 'module', imports: { '#util': './src/util.js', '#lib/*': './lib/*.js', '#dep': 'pkg0' } }));
for (let i = 0; i < 64; i++) write(`/app/src/m${i}.js`, '');
write('/app/src/util.js', '');
for (let i = 0; i < 32; i++) write(`/app/lib/l${i}.js`, '');
for (let p = 0; p < 48; p++) {
  const exportsMap = {
    '.': { types: './index.d.ts', import: './esm/index.js', require: './cjs/index.cjs', default: './esm/index.js' },
    './package.json': './package.json',
    './feature/*': { import: './esm/feature/*.js', default: './cjs/feature/*.cjs' },
    './feature/*.css': './css/*.css',
    './internal/*': null,
  };
  for (let k = 0; k < 12; k++) exportsMap[`./part${k}`] = { node: { import: `./esm/part${k}.js`, default: `./cjs/part${k}.cjs` }, default: `./esm/part${k}.js` };
  write(`/app/node_modules/pkg${p}/package.json`, JSON.stringify({ name: `pkg${p}`, type: 'module', exports: exportsMap }));
  write(`/app/node_modules/pkg${p}/esm/index.js`, '');
  write(`/app/node_modules/pkg${p}/cjs/index.cjs`, '');
  for (let k = 0; k < 12; k++) {
    write(`/app/node_modules/pkg${p}/esm/part${k}.js`, '');
    write(`/app/node_modules/pkg${p}/cjs/part${k}.cjs`, '');
  }
  for (let k = 0; k < 8; k++) write(`/app/node_modules/pkg${p}/esm/feature/f${k}.js`, '');
}
for (let p = 0; p < 16; p++) {
  write(`/app/node_modules/legacy${p}/package.json`, JSON.stringify({ name: `legacy${p}`, main: 'lib/main' }));
  write(`/app/node_modules/legacy${p}/lib/main.js`, '');
}
const host = {
  kind: (path) => (files.has(path) ? 'file' : dirs.has(path) ? 'directory' : null),
  realpath: (path) => path,
  readText: (path) => files.get(path) ?? null,
  isBuiltin: (specifier) => specifier === 'fs' || specifier === 'node:fs' || specifier === 'path' || specifier === 'node:path',
  cjsResolve: () => null,
};
const parent = 'file:///app/src/m0.js';
const specifiers = {
  relative: Array.from({ length: 64 }, (_, i) => `./m${i}.js`),
  bare: Array.from({ length: 48 }, (_, p) => [`pkg${p}`, `pkg${p}/part${p % 12}`, `pkg${p}/feature/f${p % 8}`]).flat(),
  imports: [...Array.from({ length: 32 }, (_, i) => `#lib/l${i}`), '#util', '#dep', 'node:fs', 'path'],
  misses: [...Array.from({ length: 16 }, (_, p) => `legacy${p}`), './nope.js', 'pkg3/internal/x', 'pkg4/missing', 'nopkg', '#none'],
};
const answer = (resolver, specifier) => {
  try {
    const { url, format } = resolver.resolveSync(specifier, parent);
    return `${url} ${format}`;
  } catch (error) {
    return `${error.code} ${error.message}`;
  }
};
// require()'s: relative files probed by extension, packages by main and exports, imports.
const requires = {
  'require relative': Array.from({ length: 64 }, (_, i) => `./m${i}`),
  'require bare': Array.from({ length: 48 }, (_, p) => [`pkg${p}`, `pkg${p}/part${p % 12}`]).flat().concat(Array.from({ length: 16 }, (_, p) => `legacy${p}`)),
  'require imports': [...Array.from({ length: 32 }, (_, i) => `#lib/l${i}`), '#util', 'fs', 'missing-package'],
};
const required = (resolver, id) => {
  try {
    const found = resolver.resolveSync(id, '/app/src');
    return found === null ? 'null' : `${found.path} ${found.builtin} ${found.packageType}`;
  } catch (error) {
    return `${error.code} ${error.message}`;
  }
};

const work = {};
for (const kind of Object.keys(specifiers)) {
  // A resolver per round, as a launch makes one: its package.json reads cached within the round.
  work[kind] = ({ createEsmResolver }) => {
    for (let round = 0; round < 8; round++) {
      const resolver = createEsmResolver(host, { conditions: [] });
      for (const specifier of specifiers[kind]) checksum += answer(resolver, specifier).length;
    }
  };
}
for (const kind of Object.keys(requires)) {
  work[kind] = ({ createRequireResolver }) => {
    for (let round = 0; round < 8; round++) {
      const resolver = createRequireResolver(host, { conditions: [] });
      for (const id of requires[kind]) checksum += required(resolver, id).length;
    }
  };
}

try {
  const sources = { A: baseline, null: baseline, real: repository };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await arm(name, sources[name]);
  // Each arm answers as the others do: the comparison is of the same work.
  for (const kind of Object.keys(specifiers)) {
    const baselineResolver = arms.A.createEsmResolver(host, { conditions: [] });
    const realResolver = arms.real.createEsmResolver(host, { conditions: [] });
    for (const specifier of specifiers[kind]) {
      assert.equal(answer(realResolver, specifier), answer(baselineResolver, specifier), `${kind}: ${specifier} resolves as the baseline's`);
    }
  }
  for (const kind of Object.keys(requires)) {
    const baselineResolver = arms.A.createRequireResolver(host, { conditions: [] });
    const realResolver = arms.real.createRequireResolver(host, { conditions: [] });
    for (const id of requires[kind]) assert.equal(required(realResolver, id), required(baselineResolver, id), `${kind}: ${id} resolves as the baseline's`);
  }
  const cpu = (exports, kind) => cpuMs(() => work[kind](exports));
  for (const kind of Object.keys(work)) {
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: 4, iterations: 1 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  assert.ok(checksum > 0);
} finally {
  for (const dispose of disposals) dispose();
  rmSync(scratch, { recursive: true, force: true });
}
