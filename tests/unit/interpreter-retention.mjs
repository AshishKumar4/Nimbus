// What the interpreter keeps alive is what the program keeps alive.
//
// A resident process runs for days and compiles runtime code all along
// (a dev server's modules, every edit). Whatever the interpreter keeps for
// a function must go when the program drops the function: nothing may
// collect per compile in a structure of the interpreter's own. And a
// compiled function must not keep its unit's AST, which is many times its
// text (tests/unit/interpreter-closures.mjs checks the closures that could),
// nor the interpreter's copy of it (tree.ts): this watches the nodes acorn
// builds, through the Reflect.get the copy reads each of their fields with,
// and the nodes of the copy, through the Object.freeze it freezes each with
// (both as the launch captured them at its start), and counts those still
// alive once the compiled functions are all that is held.
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
  console.log(`${result.units.functions} functions of a ${KiB(result.units.sourceBytes)} unit, compiled, run and held: ${KiB(result.units.retained)} held; of ${result.units.nodesWatched} AST nodes watched, ${result.units.nodesAlive} alive; of ${result.units.copiesWatched} nodes of the interpreter's copies, ${result.units.copiesAlive} alive`);
  // A label is a string and a completion object (about 100 bytes); one per function would be 2 MiB here.
  assert.ok(result.labels.growth < 256 * 1024, `the interpreter keeps something per compiled label: ${KiB(result.labels.growth)}`);
  assert.ok(result.units.nodesWatched > 10_000, `the probe saw acorn build the AST (${result.units.nodesWatched} nodes)`);
  assert.equal(result.units.nodesAlive, 0, 'compiled functions keep AST nodes alive');
  assert.ok(result.units.copiesWatched > 10_000, `the probe saw the interpreter copy the AST (${result.units.copiesWatched} nodes)`);
  assert.equal(result.units.copiesAlive, 0, 'compiled functions keep nodes of the interpreter\'s copy alive');
} else {
  const { loadInterpreter } = await import('./lib/interpreter-load.mjs');
  const { getHeapStatistics } = await import('node:v8');
  const used = () => {
    globalThis.gc();
    globalThis.gc();
    return getHeapStatistics().used_heap_size;
  };
  const isNode = (item) => item !== null && typeof item === 'object' && typeof item.type === 'string' && typeof item.start === 'number';
  // The interpreter reads each field of the nodes acorn builds with the Reflect.get, and freezes each
  // node of its copy of a tree with the Object.freeze, its launch captured at its start
  // (primordials.ts): this launch captures ones that watch them, while the unit compiles.
  const freeze = Object.freeze;
  const get = Reflect.get;
  const watched = [];
  let seen = new WeakSet();
  const copies = [];
  let watching = false;
  Object.freeze = function (o) {
    if (watching && isNode(o)) copies[copies.length] = new WeakRef(o);
    return Reflect.apply(freeze, Object, [o]);
  };
  Reflect.get = function (target, key, receiver) {
    if (watching && key === 'type' && isNode(target) && !seen.has(target) && Object.getPrototypeOf(target) !== null) {
      seen.add(target);
      watched[watched.length] = new WeakRef(target);
    }
    return arguments.length < 3 ? get(target, key) : get(target, key, receiver);
  };
  let interp;
  try {
    interp = loadInterpreter(process.argv[3], process.argv[4], () => Promise.reject(new Error('no imports')));
  } finally {
    Object.freeze = freeze;
    Reflect.get = get;
  }
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
  let held;
  watching = true;
  try {
    held = run(source);
    for (let i = 0; i < held.length; i++) held[i](i, 0);
  } finally {
    watching = false;
  }
  // A WeakRef keeps its target alive until the job that made it ends.
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.gc();
  let alive = 0;
  for (let i = 0; i < watched.length; i++) if (watched[i].deref() !== undefined) alive++;
  let copiesAlive = 0;
  for (let i = 0; i < copies.length; i++) if (copies[i].deref() !== undefined) copiesAlive++;
  const nodesWatched = watched.length;
  const copiesWatched = copies.length;
  // The probe's own WeakRefs and table are not what the functions hold.
  watched.length = 0;
  copies.length = 0;
  seen = null;
  const retained = used() - beforeUnit;
  const units = { functions: FUNCTIONS, sourceBytes: source.length, retained, nodesWatched, nodesAlive: alive, copiesWatched, copiesAlive };
  globalThis.keep = held;
  process.stdout.write(`${JSON.stringify({ labels, units })}\n`);
}
