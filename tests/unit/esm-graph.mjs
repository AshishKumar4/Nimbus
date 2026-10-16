#!/usr/bin/env bun
// runtime/esm-graph.ts is ECMA-262's Link() and Evaluate() of Cyclic Module
// Records, step by step: each case below drives fake records through the
// steps it names. Then a differential: seeded random graphs (cycles, a
// module with top-level await, one that throws) evaluated by it and by host
// Node's V8 from the same graph written as files, in the same order.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CyclicModuleRecord, OtherModuleRecord, evaluate, link } from '../../packages/core/src/runtime/esm-graph.ts';

/**
 * Fake records for `spec` (name → { deps, tla, throws, rejects, other, initThrows }): each logs its
 * InitializeEnvironment ('init:name'), its ExecuteModule ('name'), and, with top-level await, its completion ('name$').
 */
function graph(spec) {
  const log = [];
  const records = {};
  for (const [name, { deps = [], tla = false, throws = false, rejects = false, other = false, initThrows = false }] of Object.entries(spec)) {
    records[name] = other
      ? new OtherModuleRecord({
        link() { log.push(`link:${name}`); },
        evaluateSync() {
          log.push(name);
          if (throws) throw new Error(name);
        },
      })
      : new CyclicModuleRecord({
        hasTLA: tla,
        requestedModules: () => deps.map((dep) => records[dep]),
        initializeEnvironment() {
          log.push(`init:${name}`);
          if (initThrows) throw new Error(`init ${name}`);
        },
        executeModule(capability) {
          log.push(name);
          if (!tla) {
            if (throws) throw new Error(name);
            return;
          }
          Promise.resolve().then(() => {
            log.push(`${name}$`);
            if (rejects) capability.reject(new Error(name));
            else capability.resolve();
          });
        },
      });
  }
  return { log, records };
}
const settle = async () => { for (let i = 0; i < 20; i++) await null; };
const evaluated = (log) => log.filter((entry) => !entry.startsWith('init:') && !entry.startsWith('link:'));

// ── InnerModuleLinking: post-order InitializeEnvironment, every module ~linked~ ──
{
  const { log, records } = graph({ A: { deps: ['B'] }, B: { deps: ['C'] }, C: {} });
  link(records.A);
  assert.deepEqual(log, ['init:C', 'init:B', 'init:A'], 'step 10 runs after each request is linked (step 9)');
  assert.deepEqual(Object.values(records).map((r) => r.status), ['linked', 'linked', 'linked']);
}
// ── Link() step 4: a failure sets every module still on the stack back to ~unlinked~ ──
{
  const { records } = graph({ A: { deps: ['B'] }, B: { deps: ['C'], initThrows: true }, C: {} });
  assert.throws(() => link(records.A), /init B/);
  assert.deepEqual([records.A.status, records.B.status, records.C.status], ['unlinked', 'unlinked', 'linked'], 'C, its own component, was linked (step 13) before B failed');
}
// ── InnerModuleLinking steps 9.c.iii and 13: a cycle links as one component, at its root ──
{
  const { log, records } = graph({ A: { deps: ['B'] }, B: { deps: ['A'] } });
  link(records.A);
  assert.equal(records.B.dfsAncestorIndex, records.A.dfsAncestorIndex, "B's [[DFSAncestorIndex]] is A's");
  assert.deepEqual(log, ['init:B', 'init:A']);
  assert.deepEqual([records.A.status, records.B.status], ['linked', 'linked']);
}
// ── InnerModuleEvaluation: dependencies first; a cycle's [[CycleRoot]]; Evaluate() one promise per component ──
{
  const { log, records } = graph({ A: { deps: ['B'] }, B: { deps: ['A', 'C'] }, C: {} });
  link(records.A);
  const promise = evaluate(records.A);
  assert.deepEqual(evaluated(log), ['C', 'B', 'A']);
  assert.equal(records.B.cycleRoot, records.A, 'step 16.b.viii');
  assert.equal(records.C.cycleRoot, records.C);
  assert.equal(evaluate(records.A), promise, 'Evaluate() step 4: its [[TopLevelCapability]]');
  assert.equal(evaluate(records.B), promise, 'Evaluate() step 3.a: a module of the component gets its root\'s');
  await promise;
}
// ── Evaluate() step 9: a throw sets [[EvaluationError]] on the stack's modules, and rejects; again, the same ──
{
  const { log, records } = graph({ A: { deps: ['B'] }, B: { deps: ['C'], throws: true }, C: {} });
  link(records.A);
  await assert.rejects(evaluate(records.A), /^Error: B$/);
  assert.deepEqual(evaluated(log), ['C', 'B']);
  assert.equal(records.A.evaluationError?.value.message, 'B');
  assert.equal(records.B.evaluationError?.value.message, 'B');
  assert.equal(records.C.evaluationError, null);
  await assert.rejects(evaluate(records.A), /^Error: B$/, 'its [[TopLevelCapability]] again');
  assert.deepEqual(evaluated(log), ['C', 'B'], 'and nothing runs again');
}
// ── InnerModuleEvaluation steps 11.c.v and 12: top-level await, [[PendingAsyncDependencies]], [[AsyncParentModules]] ──
{
  const { log, records } = graph({ A: { deps: ['B'] }, B: { deps: ['C'], tla: true }, C: {} });
  link(records.A);
  const promise = evaluate(records.A);
  assert.deepEqual(evaluated(log), ['C', 'B'], 'A waits for B');
  assert.equal(records.A.status, 'evaluating-async');
  assert.equal(records.A.pendingAsyncDependencies, 1);
  assert.deepEqual(Array.from(records.B.asyncParentModules), [records.A]);
  await promise;
  assert.deepEqual(evaluated(log), ['C', 'B', 'B$', 'A'], 'AsyncModuleExecutionFulfilled runs A');
  assert.deepEqual([records.A.status, records.B.asyncEvaluationOrder], ['evaluated', 'done']);
}
// ── AsyncModuleExecutionRejected: a rejection reaches each [[AsyncParentModules]], none of which runs ──
{
  const { log, records } = graph({ A: { deps: ['B'] }, B: { tla: true, rejects: true } });
  link(records.A);
  await assert.rejects(evaluate(records.A), /^Error: B$/);
  assert.deepEqual(evaluated(log), ['B', 'B$']);
  assert.equal(records.A.evaluationError?.value.message, 'B');
}
// ── GatherAvailableAncestors and AsyncModuleExecutionFulfilled step 11: ancestors run by [[AsyncEvaluationOrder]] ──
{
  const { log, records } = graph({ R: { deps: ['X', 'Y'] }, X: { deps: ['T'] }, Y: { deps: ['T'] }, T: { tla: true } });
  link(records.R);
  await evaluate(records.R);
  assert.deepEqual(evaluated(log), ['T', 'T$', 'X', 'Y', 'R']);
  assert.ok(records.X.asyncEvaluationOrder === 'done' && records.R.status === 'evaluated');
}
// ── InnerModuleLinking and InnerModuleEvaluation step 1: a Module Record that is not cyclic ──
{
  const { log, records } = graph({ A: { deps: ['J', 'B'] }, B: { deps: ['J'] }, J: { other: true } });
  link(records.A);
  await evaluate(records.A);
  assert.deepEqual(log, ['link:J', 'link:J', 'init:B', 'init:A', 'J', 'J', 'B', 'A'], 'Link() and EvaluateModuleSync each time it is reached');
}

// ── Two dependencies with top-level await: their ancestor runs once both completed ──
{
  const { log, records } = graph({ R: { deps: ['A', 'B'] }, A: { tla: true }, B: { tla: true } });
  link(records.R);
  await evaluate(records.R);
  assert.deepEqual(evaluated(log), ['A', 'B', 'A$', 'B$', 'R']);
}
// ── What a program may replace is never reached: a prototype's methods, the array iterator, Promise.prototype.then ──
{
  const log = [];
  const records = {};
  const requested = { A: [], B: [], C: [] };
  const make = (name, deps, tla) => {
    records[name] = new CyclicModuleRecord({
      hasTLA: tla,
      requestedModules: () => requested[name],
      initializeEnvironment() { log[log.length] = `init:${name}`; },
      executeModule(capability) {
        log[log.length] = name;
        if (tla) queueMicrotask(() => { log[log.length] = `${name}$`; capability.resolve(); });
      },
    });
    return deps;
  };
  const depsOf = { A: make('A', ['B', 'C'], false), B: make('B', ['A', 'C'], false), C: make('C', [], true) };
  for (const name of ['A', 'B', 'C']) for (let i = 0; i < depsOf[name].length; i++) requested[name][i] = records[depsOf[name][i]];
  const reached = [];
  const replaced = [
    [Array.prototype, 'push'], [Array.prototype, 'pop'], [Array.prototype, 'includes'], [Array.prototype, 'sort'],
    [Array.prototype, Symbol.iterator], [Promise.prototype, 'then'], [Math, 'min'],
  ].map((entry) => {
    // Not destructured: the array iterator may already be replaced.
    const target = entry[0];
    const key = entry[1];
    const original = target[key];
    target[key] = function (...args) { reached[reached.length] = String(key); return Reflect.apply(original, this, args); };
    return () => { target[key] = original; };
  });
  // Restored once the evaluation completes: its asynchronous steps (AsyncModuleExecutionFulfilled) are checked too.
  try {
    link(records.A);
    await evaluate(records.A);
  } finally {
    for (let i = 0; i < replaced.length; i++) replaced[i]();
  }
  assert.deepEqual(reached, [], 'nothing replaceable was reached');
  assert.deepEqual(evaluated(log), ['C', 'C$', 'B', 'A']);
}

// ── Nor does a program's array index accessor, Promise[Symbol.species] or Promise.prototype.constructor: the graph's
//    Lists have no prototype, and the promise it thens answers its own species. Each installed from before Link() to
//    after Evaluate() returns, which is when the graph registers its reaction to the awaiting module. ──
{
  // The test's own lists have no prototype either: the accessors would see them.
  const list = () => Object.setPrototypeOf([], null);
  const log = list();
  const reached = list();
  const records = {};
  const requested = { A: [], B: [], C: [], D: [] };
  const make = (name, tla) => {
    records[name] = new CyclicModuleRecord({
      hasTLA: tla,
      requestedModules: () => requested[name],
      initializeEnvironment() { log[log.length] = `init:${name}`; },
      executeModule(capability) {
        log[log.length] = name;
        if (tla) queueMicrotask(() => { log[log.length] = `${name}$`; capability.resolve(); });
      },
    });
  };
  for (const [name, tla] of [['A', false], ['B', false], ['C', true], ['D', true]]) make(name, tla);
  const edges = { A: ['B', 'C', 'D'], B: ['A', 'C'], C: [], D: [] };
  for (const name of ['A', 'B', 'C', 'D']) for (let i = 0; i < edges[name].length; i++) requested[name][i] = records[edges[name][i]];
  const indices = [0, 1, 2, 3];
  for (const i of indices) {
    Object.defineProperty(Array.prototype, i, { configurable: true, get() { reached[reached.length] = `get[${i}]`; }, set() { reached[reached.length] = `set[${i}]`; } });
  }
  const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { reached[reached.length] = 'species'; throw new Error('species'); } });
  const constructor = Promise.prototype.constructor;
  function Hostile() {}
  Object.defineProperty(Hostile, Symbol.species, { get() { reached[reached.length] = 'constructor'; throw new Error('constructor'); } });
  Promise.prototype.constructor = Hostile;
  let promise;
  try {
    link(records.A);
    promise = evaluate(records.A);
  } finally {
    Promise.prototype.constructor = constructor;
    Object.defineProperty(Promise, Symbol.species, species);
    for (const i of indices) delete Array.prototype[i];
  }
  await promise;
  assert.deepEqual(Array.from(reached), [], 'no accessor, species or constructor of the program was reached');
  assert.deepEqual(evaluated(Array.from(log)), ['C', 'D', 'C$', 'D$', 'B', 'A']);
}

// ── Differential: random graphs, as host Node evaluates the same files ──
let seed = 0x5eed;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const GRAPHS = 120;
const graphs = [];
for (let g = 0; g < GRAPHS; g++) {
  const size = 2 + Math.floor(random() * 6);
  const tla = random() < 0.5 ? Math.floor(random() * size) : -1;
  const thrower = random() < 0.25 ? Math.floor(random() * size) : -1;
  const spec = {};
  for (let i = 0; i < size; i++) {
    const deps = [];
    for (let j = 0; j < size; j++) if (j !== i && random() < 0.35) deps.push(`m${j}`);
    spec[`m${i}`] = { deps, tla: i === tla, throws: i === thrower && i !== tla };
  }
  graphs.push(spec);
}
const dir = mkdtempSync(join(tmpdir(), 'esm-graph-'));
let expected;
try {
  graphs.forEach((spec, g) => {
    mkdirSync(join(dir, `g${g}`));
    for (const [name, { deps, tla, throws }] of Object.entries(spec)) {
      const body = [`globalThis.log.push('${name}');`];
      if (tla) body.push(`await null; globalThis.log.push('${name}$');`);
      if (throws) body.push(`throw new Error('${name}');`);
      writeFileSync(join(dir, `g${g}`, `${name}.mjs`), [...deps.map((dep) => `import './${dep}.mjs';`), ...body].join('\n') + '\n');
    }
  });
  writeFileSync(join(dir, 'run.mjs'), `const out = [];
for (let g = 0; g < ${GRAPHS}; g++) {
  globalThis.log = [];
  try { await import('./g' + g + '/m0.mjs'); } catch (e) { globalThis.log.push('!' + e.message); }
  out.push(globalThis.log);
}
console.log(JSON.stringify(out));
`);
  const ran = spawnSync('node', [join(dir, 'run.mjs')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  expected = JSON.parse(ran.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const ours = [];
for (const spec of graphs) {
  const { log, records } = graph(spec);
  link(records.m0);
  try { await evaluate(records.m0); } catch (e) { log.push('!' + e.message); }
  await settle();
  ours.push(evaluated(log));
}
assert.deepEqual(ours, expected, "the order host Node's V8 evaluates each graph in");
assert.ok(expected.some((log) => log.some((entry) => entry.endsWith('$'))) && expected.some((log) => log.some((entry) => entry.startsWith('!'))), 'the graphs await and throw');
console.log(`ok - esm-graph (each step on fake records; ${GRAPHS} random graphs evaluated as host Node evaluates them)`);
