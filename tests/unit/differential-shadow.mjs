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

/** The report's comparisons: how many, the mismatches, those still waiting at exit, and those not comparable. */
const compared = ({ report }) => ({
  compared: report.compared ?? 0,
  mismatches: report.mismatches ?? [],
  awaiting: report.awaiting ?? 0,
  uncomparable: (report.uncomparable ?? []).length,
});

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
    assert.deepEqual(compared(run), { compared: 1, mismatches: [], awaiting: 0, uncomparable: 0 });
  }

  // An ordinary function called with new is constructed both ways and compared.
  {
    const run = shadowRun('construct', `
      const Point = Function('x', 'this.x = x; this.twice = x * 2;');
      const point = new Point(3);
      const out = { x: point.x, twice: point.twice, instance: point instanceof Point };
    `);
    assert.deepEqual(run.out, { x: 3, twice: 6, instance: true });
    assert.deepEqual(compared(run), { compared: 1, mismatches: [], awaiting: 0, uncomparable: 0 });
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
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0, uncomparable: 0 });
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
    assert.deepEqual(compared(run), { compared: 6, mismatches: [], awaiting: 0, uncomparable: 0 });
  }
  // The hooked constructors' [[Prototype]]s are the hooked ones: AsyncFunction's parent is the hooked Function.
  {
    const run = shadowRun('constructor-parents', `
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const out = { parent: Object.getPrototypeOf(AsyncFunction) === Function, value: Object.getPrototypeOf(AsyncFunction)('return 7')() };
    `);
    assert.deepEqual(run.out, { parent: true, value: 7 });
    assert.deepEqual(compared(run), { compared: 1, mismatches: [], awaiting: 0, uncomparable: 0 });
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
    `);
    assert.deepEqual(run.out, { tag: '[object GeneratorFunction]', name: 'anonymous', length: 1, instance: true, extra: 'on the prototype', first: 4, second: 5, construct: 'TypeError', detached: 'TypeError' });
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0, uncomparable: 0 });
  }

  // An object a generator yields, sent back in, reaches the copy as the copy's own.
  {
    const run = shadowRun('generator-token', `
      const Generator = Object.getPrototypeOf(function* () {}).constructor;
      const it = Generator('const token = {}; return (yield token) === token;')();
      const first = it.next();
      const out = { same: it.next(first.value).value };
    `);
    assert.deepEqual(run.out, { same: true });
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0, uncomparable: 0 });
  }

  // A run whose native call changes its inputs runs once and is not compared.
  {
    const run = shadowRun('changed-inputs', `
      const Count = Function('s', 'this.n = ++s.n;');
      const state = { n: 0 };
      const counted = new Count(state);
      const out = { n: counted.n, state: state.n };
    `);
    assert.deepEqual(run.out, { n: 1, state: 1 });
    assert.deepEqual(compared(run), { compared: 0, mismatches: [], awaiting: 0, uncomparable: 1 });
  }

  // A thenable is the program's as returned, and compared by what it settles to;
  // a rejected Promise the program leaves alone is still unhandled.
  {
    const run = shadowRun('awaitables', `
      const unhandled = [];
      process.on('unhandledRejection', (reason) => unhandled.push(reason.message));
      const thenable = Function('return { then(resolve) { resolve(5); } }')();
      const out = { thenable: typeof thenable.then === 'function' && !(thenable instanceof Promise), settled: await thenable };
      Function('return Promise.reject(new Error("left alone"))')();
      await new Promise((resolve) => setTimeout(resolve, 50));
      out.unhandled = unhandled;
    `);
    assert.deepEqual(run.out, { thenable: true, settled: 5, unhandled: ['left alone'] });
    assert.deepEqual(compared(run), { compared: 2, mismatches: [], awaiting: 0, uncomparable: 0 });
  }

  // A comparison still waiting when the run ends is reported.
  {
    const run = shadowRun('never-settles', `
      Function('return new Promise(() => {})')();
      const out = {};
    `);
    assert.deepEqual(compared(run), { compared: 0, mismatches: [], awaiting: 1, uncomparable: 0 });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok - differential-shadow: pair-aware comparison; coercion once; construction, awaitables and generators compared as the program sees them');
