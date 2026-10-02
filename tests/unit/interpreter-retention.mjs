// What the interpreter keeps alive is what the program keeps alive.
//
// A resident process runs for days and compiles runtime code all along
// (a dev server's modules, every edit). Whatever the interpreter keeps for
// a function must go when the program drops the function: nothing may
// collect per compile in a structure of the interpreter's own. And a
// compiled function must not keep its unit's AST, which is many times its
// text (tests/unit/interpreter-closures.mjs checks the closures that could):
// this watches the nodes acorn builds, through the Array.prototype.push it
// builds them with, and counts those still alive once the compiled
// functions are all that is held.
//
// Under bun this builds the interpreter and measures in node with
// --expose-gc, so the heap is measured after full collections.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--measure') {
  const { buildInterpreterFiles } = await import('./lib/interpreter-build.mjs');
  const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
  let run;
  try {
    run = spawnSync('node', ['--expose-gc', '--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--measure', interpreterFile, opsFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.stderr.write(run.stderr);
  assert.equal(run.status, 0, 'the measuring process failed');
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const KiB = (n) => `${(n / 1024).toFixed(0)} KiB`;
  console.log(`${result.labels.functions} functions with labels of their own, compiled, run and dropped: heap ${KiB(result.labels.growth)} larger`);
  console.log(`${result.units.functions} functions of a ${KiB(result.units.sourceBytes)} unit, compiled, run and held: ${KiB(result.units.retained)} held; of ${result.units.nodesWatched} AST nodes watched, ${result.units.nodesAlive} alive`);
  // A label is a string and a completion object (about 100 bytes); one per function would be 2 MiB here.
  assert.ok(result.labels.growth < 256 * 1024, `the interpreter keeps something per compiled label: ${KiB(result.labels.growth)}`);
  assert.ok(result.units.nodesWatched > 10_000, `the probe saw acorn build the AST (${result.units.nodesWatched} nodes)`);
  assert.equal(result.units.nodesAlive, 0, 'compiled functions keep AST nodes alive');
} else {
  const { loadInterpreter } = await import('./lib/interpreter-load.mjs');
  const { getHeapStatistics } = await import('node:v8');
  const used = () => {
    globalThis.gc();
    globalThis.gc();
    return getHeapStatistics().used_heap_size;
  };
  const interp = loadInterpreter(process.argv[3], process.argv[4], () => Promise.reject(new Error('no imports')));
  const run = (text) => interp.compileFunction('function', [], text)();
  const labelled = (name, i) => run(`${name}: for (let k = 0; k < 2; k++) { for (;;) { ${i % 2 ? 'break' : 'continue'} ${name}; } }`);
  // Warm the interpreter's own code first (and V8's caches): what its first compiles leave is part of loading it.
  for (let i = 0; i < 10_000; i++) labelled(`w${i}`, i);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const LABELS = 20_000;
  const before = used();
  for (let i = 0; i < LABELS; i++) labelled(`l${i}`, i);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const labels = { functions: LABELS, growth: Math.max(0, used() - before) };

  // One unit of many small functions, each called once (so compiled), all held.
  const FUNCTIONS = 2_000;
  let source = 'const fns = [];\n';
  for (let i = 0; i < FUNCTIONS; i++) {
    source += `fns.push(function f${i}(a, b) { const o = { k: a, v: [b, ${i}] }; for (let j = 0; j < 2; j++) { if (o.v[j] === b) return o.k + j; } return \`\${a}-\${b}-${i}\`; });\n`;
  }
  source += 'return fns;';
  const beforeUnit = used();
  // acorn builds every list of the AST with push: watch what it pushes, while the unit compiles.
  const watched = [];
  const push = Array.prototype.push;
  Array.prototype.push = function (...items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== null && typeof item === 'object' && typeof item.type === 'string' && typeof item.start === 'number') watched[watched.length] = new WeakRef(item);
    }
    return Reflect.apply(push, this, items);
  };
  let held;
  try {
    held = run(source);
    for (let i = 0; i < held.length; i++) held[i](i, 0);
  } finally {
    Array.prototype.push = push;
  }
  // A WeakRef keeps its target alive until the job that made it ends.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retained = used() - beforeUnit;
  let alive = 0;
  for (let i = 0; i < watched.length; i++) if (watched[i].deref() !== undefined) alive++;
  const units = { functions: FUNCTIONS, sourceBytes: source.length, retained, nodesWatched: watched.length, nodesAlive: alive };
  globalThis.keep = held;
  process.stdout.write(`${JSON.stringify({ labels, units })}\n`);
}
