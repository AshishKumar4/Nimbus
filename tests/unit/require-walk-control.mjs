#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { prefetchForRequire, requireFsOverBridge } from '../../packages/core/src/runtime/require-resolver.ts';
import { TurnBudget } from '../../packages/fabric/src/turn-budget.ts';
import { launchFs } from './lib/launch-fs.mjs';

// Directory resolution needs the intermediate package metadata at runtime,
// even when reading that metadata completes later than reading its target.
{
  const inner = 'home/user/node_modules/pkg/inner/package.json';
  const text = JSON.stringify({ main: '../other.js' });
  const world = launchFs({
    'home/user/node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', main: 'inner' }),
    [inner]: text,
    'home/user/node_modules/pkg/other.js': 'module.exports = 42;',
  });
  const fs = requireFsOverBridge(world.fs);
  const read = fs.readFileString;
  fs.readFileString = async path => {
    if (path === inner) { await setImmediate(); await setImmediate(); }
    return read(path);
  };
  const result = await prefetchForRequire(fs, "require('pkg')", '/home/user');
  assert.equal(result.bundle[inner], text, 'the completed closure includes asynchronously read directory-resolution metadata');
}

// JSON has read/decoding work even though it does not scan for dependencies.
{
  const text = JSON.stringify('x'.repeat(12 * 1024));
  const world = launchFs({ 'home/user/data.json': text });
  let grants = 0;
  const budget = new TurnBudget({ async nextTurn() { grants++; await setImmediate(); } }, 4096);
  const result = await prefetchForRequire(requireFsOverBridge(world.fs), "require('./data.json')", '/home/user',
    undefined, undefined, work => budget.spend(work));
  budget.settle();
  assert.ok(grants > 0, 'JSON content spends work even though it has no dependency-source scan');
  assert.equal(result.bundle['home/user/data.json'], text);
}

// Rejection after entering package resolution must not look like a missing
// optional file. Exercise both CJS fallback catches and the ESM error boundary.
for (const entry of ["require('pkg')", "import('pkg')"]) {
  for (const action of ['schedule', 'cancel']) {
    const pkg = 'home/user/node_modules/pkg/package.json';
    const world = launchFs({
      [pkg]: JSON.stringify({ name: 'pkg', exports: './deep/entry.js' }),
      'home/user/node_modules/pkg/deep/entry.js': 'module.exports = 42;',
    });
    const failure = new Error(action + ' failed during dependency resolution');
    let triggered = false;
    const budget = new TurnBudget({
      async nextTurn() {
        triggered = true;
        if (action === 'schedule') throw failure;
      },
    }, 1, () => { if (action === 'cancel') throw failure; });
    await assert.rejects(
      prefetchForRequire(requireFsOverBridge(world.fs), entry, '/home/user', undefined, undefined,
        async work => { if (world.reads.includes(pkg)) await budget.spend(work); }),
      error => error === failure,
      `${action} failure escapes ${entry} with its original identity, not a partial graph`,
    );
    budget.settle();
    assert.equal(triggered, true);
  }
}
// Recursing into each child must not restart the parent's regexp cursor and
// resolve its entire prefix again. Doubling this flat graph costs linear work.
async function wideGraph(count) {
  const root = 'home/user/node_modules/wide';
  const files = { [root + '/package.json']: '{"name":"wide"}' };
  for (let i = 0; i < count; i++) files[root + `/m${i}.js`] = `module.exports = ${i};`;
  const world = launchFs(files);
  const entry = Array.from({ length: count }, (_, i) => `require('./m${i}.js');`).join('\n');
  const result = await prefetchForRequire(requireFsOverBridge(world.fs), entry, '/' + root);
  for (let i = 0; i < count; i++) assert.equal(result.bundle[root + `/m${i}.js`], files[root + `/m${i}.js`]);
  return world.stats.length;
}
const smallWork = await wideGraph(20);
const largeWork = await wideGraph(40);
assert.ok(largeWork <= 3 * smallWork, `recursive graph work is linear: ${smallWork} -> ${largeWork} probes`);

// Pause two real asynchronous filesystem reads after different match offsets.
// JSON children do not scan source, so they expose a shared parent's cursor.
{
  const world = launchFs({
    'home/user/a.json': '1', 'home/user/b.json': '2',
    'home/user/other.json': '3', 'home/user/last.json': '4',
  });
  const gates = new Map(['a.json', 'other.json'].map(name => [name, {
    entered: Promise.withResolvers(), release: Promise.withResolvers(),
  }]));
  const fs = requireFsOverBridge(world.fs);
  const read = fs.readFileString;
  fs.readFileString = async path => {
    const gate = gates.get(path.slice(path.lastIndexOf('/') + 1));
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    return read(path);
  };
  const first = prefetchForRequire(fs, "require('./a.json'); require('./b.json');", '/home/user');
  await gates.get('a.json').entered.promise;
  const second = prefetchForRequire(fs, ' '.repeat(1000) + "require('./other.json'); require('./last.json');", '/home/user');
  await gates.get('other.json').entered.promise;
  gates.get('a.json').release.resolve();
  const firstGraph = await first;
  gates.get('other.json').release.resolve();
  const secondGraph = await second;
  assert.equal(firstGraph.bundle['home/user/b.json'], '2', 'a peer traversal cannot skip the first graph\'s remaining dependency');
  assert.equal(secondGraph.bundle['home/user/last.json'], '4', 'both interleaved closures remain complete');
}
console.log(`require-walk-control: complete asynchronous/interleaved closures; 20/40 children cost ${smallWork}/${largeWork} probes; original control failures propagate`);
