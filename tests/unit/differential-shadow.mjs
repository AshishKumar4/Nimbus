#!/usr/bin/env bun
// The interpreter differential's shadow run (tests/differential/lib/
// shadow-preload.mjs), loaded with `node --import` into small programs as it
// is into a framework run: the program must get what V8 gives it, and every
// function a Function constructor builds must be compared with the
// interpreter's on the same inputs, whatever its kind and however it is
// called. And the comparison itself (same.mjs) must look at each pair of
// values, not each value once.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readReport } from '../differential/lib/report.mjs';
import { same } from '../differential/lib/same.mjs';
import { buildInterpreterFiles } from './lib/interpreter-build.mjs';

// A value reached twice on one side and as two different values on the other is compared both times.
{
  const shared = { value: 1 };
  const difference = same({ left: shared, right: shared }, { left: { value: 1 }, right: { value: 2 } }, 'result', 3);
  assert.equal(difference, 'result.right.value: number 1 vs number 2');
  const cycle = { name: 'a' };
  cycle.self = cycle;
  const copy = { name: 'a' };
  copy.self = copy;
  assert.equal(same(cycle, copy, 'result', 3), null, 'a cycle on both sides ends');
}

const PRELOAD = fileURLToPath(new URL('../differential/lib/shadow-preload.mjs', import.meta.url));
const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
const work = mkdtempSync(join(tmpdir(), 'differential-shadow-'));

/**
 * Run `source` (an ES module) under the shadow preload. Resolves to what it
 * printed as JSON on its last line, and the run's report.
 */
function shadowRun(name, source) {
  const program = join(work, `${name}.mjs`);
  const report = join(work, `${name}.report`);
  writeFileSync(program, `${source}\nconsole.log(JSON.stringify(out));\n`);
  const run = spawnSync('node', ['--import', PRELOAD, program], {
    encoding: 'utf8',
    env: { ...process.env, NIMBUS_INTERPRETER: interpreterFile, NIMBUS_INTERPRETER_OPS: opsFile, NIMBUS_DIFF_REPORT: report, NIMBUS_DIFF_CORPUS: join(work, `${name}.corpus`) },
  });
  assert.equal(run.status, 0, `${name}: exit ${run.status}\n${run.stdout}\n${run.stderr}`);
  return { out: JSON.parse(run.stdout.trim().split('\n').at(-1)), report: readReport(report) };
}

/** The report's comparisons: how many, the mismatches, and those still waiting at exit. */
const compared = ({ report }) => ({ compared: report.compared ?? 0, mismatches: report.mismatches ?? [], awaiting: report.awaiting ?? 0 });

try {
  // Each argument is converted to a string once, as Function converts it: the
  // native function and the interpreted one are built from the same text.
  {
    const run = shadowRun('coerce-once', `
      let conversions = 0;
      const body = { toString: () => 'return ' + ++conversions };
      const f = Function(body);
      const out = { value: f(), conversions };
      try { Function(Symbol('body')); out.symbol = 'built'; } catch (e) { out.symbol = e.constructor.name; }
    `);
    assert.deepEqual(run.out, { value: 1, conversions: 1, symbol: 'TypeError' });
    assert.deepEqual(compared(run), { compared: 1, mismatches: [], awaiting: 0 });
  }

  // An ordinary function called with new is constructed both ways and compared.
  {
    const run = shadowRun('construct', `
      const Point = Function('x', 'this.x = x; this.twice = x * 2;');
      const point = new Point(3);
      const out = { x: point.x, twice: point.twice, instance: point instanceof Point };
    `);
    assert.deepEqual(run.out, { x: 3, twice: 6, instance: true });
    assert.deepEqual(compared(run), { compared: 1, mismatches: [], awaiting: 0 });
  }

  // A function returning a Promise gives the program that Promise, and the
  // two are compared by what they settle to.
  {
    const run = shadowRun('promise', `
      const make = Function('value', 'return Promise.resolve(value + 1)');
      const promise = make(1);
      const out = { promise: promise instanceof Promise, value: await promise };
      const fails = Function('return Promise.reject(new Error("no"))');
      out.rejected = await fails().then(() => 'fulfilled', (e) => e.message);
    `);
    assert.deepEqual(run.out, { promise: true, value: 2, rejected: 'no' });
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0 });
  }

  // A generator's and an async generator's iterations are compared step by step.
  {
    const run = shadowRun('generators', `
      const Generator = Object.getPrototypeOf(function* () {}).constructor;
      const AsyncGenerator = Object.getPrototypeOf(async function* () {}).constructor;
      const counted = [...Generator('n', 'for (let i = 0; i < n; i++) yield i * 10;')(2)];
      const awaited = [];
      for await (const value of AsyncGenerator('yield "a"; yield "b";')()) awaited.push(value);
      const out = { counted, awaited };
    `);
    assert.deepEqual(run.out, { counted: [0, 10], awaited: ['a', 'b'] });
    // Each next(), to the one that ends it: three of each kind.
    assert.deepEqual(compared(run), { compared: 6, mismatches: [], awaiting: 0 });
  }
  // The hooked constructors' [[Prototype]]s are the hooked ones: AsyncFunction's parent is the hooked Function.
  {
    const run = shadowRun('constructor-parents', `
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const out = { parent: Object.getPrototypeOf(AsyncFunction) === Function, value: Object.getPrototypeOf(AsyncFunction)('return 7')() };
    `);
    assert.deepEqual(run.out, { parent: true, value: 7 });
    assert.deepEqual(compared(run), { compared: 1, mismatches: [], awaiting: 0 });
  }

  // A generator function is one to the program, and its objects are native ones.
  {
    const run = shadowRun('generator-shape', `
      const Generator = Object.getPrototypeOf(function* () {}).constructor;
      const g = Generator('n', 'yield n; yield n + 1;');
      g.prototype.extra = 'on the prototype';
      const it = g(4);
      const out = {
        tag: Object.prototype.toString.call(g),
        name: g.name,
        length: g.length,
        instance: it instanceof g,
        extra: it.extra,
        first: Object.getPrototypeOf(it).next.call(it).value,
        second: it.next().value,
      };
      try { Reflect.construct(Object, [], g); out.construct = 'constructed'; } catch (e) { out.construct = e.constructor.name; }
      const detached = it.next;
      try { detached.call({}); out.detached = 'advanced'; } catch (e) { out.detached = e.constructor.name; }
      const h = Generator('yield 1');
      const replaced = Object.create(Object.getPrototypeOf(h.prototype));
      replaced.marker = 'replaced';
      h.prototype = replaced;
      const hit = h();
      out.replaced = [hit.marker, hit instanceof h];
      // A synchronous generator's call needs nothing of the program's Promise.
      const saved = Promise;
      try { globalThis.Promise = undefined; out.withoutPromise = Generator('yield 1')().constructor === undefined ? 'no constructor' : 'made'; } finally { globalThis.Promise = saved; }
    `);
    assert.deepEqual(run.out, { tag: '[object GeneratorFunction]', name: 'anonymous', length: 1, instance: true, extra: 'on the prototype', first: 4, second: 5, construct: 'TypeError', detached: 'TypeError', replaced: ['replaced', true], withoutPromise: 'made' });
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0 });
  }

  // An object or function a generator or async generator yields, sent back
  // in, reaches the copy as the copy's own.
  {
    const run = shadowRun('generator-token', `
      const Generator = Object.getPrototypeOf(function* () {}).constructor;
      const AsyncGenerator = Object.getPrototypeOf(async function* () {}).constructor;
      const object = Generator('const token = {}; return (yield token) === token;')();
      const fn = Generator('const token = () => 1; return (yield token) === token;')();
      const awaited = AsyncGenerator('const token = {}; return (yield token) === token;')();
      const out = {
        object: object.next(object.next().value).value,
        fn: fn.next(fn.next().value).value,
        awaited: (await awaited.next((await awaited.next()).value)).value,
      };
    `);
    assert.deepEqual(run.out, { object: true, fn: true, awaited: true });
    assert.deepEqual(compared(run), { compared: 6, mismatches: [], awaiting: 0 });
  }

  // The contract: the copy runs on the inputs the native run left. A function
  // that changes them is a loud mismatch, never a silent pass.
  {
    const run = shadowRun('shared-inputs', `
      const state = { n: 0 };
      const out = { value: Function('s', 'return ++s.n')(state), n: state.n };
    `);
    assert.deepEqual(run.out, { value: 1, n: 2 });
    assert.deepEqual(compared(run).mismatches.map((m) => m.difference), ['result: number 1 vs number 2']);
  }

  // What a function returns is the program's own: a thenable as it is, a
  // Promise the same Promise; each is compared by what it settles to.
  {
    const run = shadowRun('awaitables', `
      const thenable = Function('return { then(resolve) { resolve(5); } }')();
      const out = { thenable: typeof thenable.then === 'function' && !(thenable instanceof Promise), settled: await thenable };
      const promise = Promise.resolve(3);
      out.same = Function('p', 'return p')(promise) === promise;
    `);
    assert.deepEqual(run.out, { thenable: true, settled: 5, same: true });
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0 });
  }

  // A comparison still waiting when the run ends is reported.
  {
    const run = shadowRun('never-settles', `
      Function('return new Promise(() => {})')();
      const out = {};
    `);
    assert.deepEqual(compared(run), { compared: 0, mismatches: [], awaiting: 1 });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok - differential-shadow: pair-aware comparison; coercion once; construction, awaitables and generators compared, the program given what V8 gives it');
