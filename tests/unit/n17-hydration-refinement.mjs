#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.Hydration (FormalModelsLane 071dc802,
// lean/fixtures/n17-hydration.json, N17-001). Each case builds its files in
// a source store (one 64 KiB chunk per hash name, the same bytes for the same
// name), and lazily imports them into the session's store under /imp and
// /app with bytes for every hash the case does not leave remote. The
// remote ones stay pending, queued in the case's order. The events then run
// against a Hydrator over the session's store, through a process's bound
// filesystem: a job is one step (fetching from the source), a tick a second
// on a fake clock, an asynchronous read the hydrator's wait followed by a
// read, a synchronous read the bridge's own. After every event the answer,
// the gates and the queue must be the model's.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/n17-hydration.json', import.meta.url), 'utf8'));
const CHUNK = 65_536;
const bytesOf = (name) => {
  const out = new Uint8Array(CHUNK);
  const seed = new TextEncoder().encode(`chunk ${name};`);
  for (let i = 0; i < CHUNK; i++) out[i] = seed[i % seed.length];
  return out;
};
const sha = (data) => createHash('sha256').update(data).digest('hex');
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

async function runCase(testCase, index) {
  const names = new Set([...Object.values(testCase.files).flat(), ...testCase.remote]);
  const hashOf = new Map([...names].map((name) => [name, sha(bytesOf(name))]));
  const nameOf = new Map([...hashOf].map(([name, hash]) => [hash, name]));
  const remote = new Set(testCase.remote.map((name) => hashOf.get(name)));

  const source = new SqliteVFS(...(({ sql, ctx }) => [sql, ctx])(createSqliteVfsTestHarness()));
  const src = source.as(CRED_KERNEL);
  for (const [path, chunks] of Object.entries(testCase.files)) {
    src.mkdir(path.slice(1, path.lastIndexOf('/')), { recursive: true });
    const content = new Uint8Array(chunks.length * CHUNK);
    chunks.forEach((name, i) => content.set(bytesOf(name), i * CHUNK));
    src.writeFile(path.slice(1), content);
  }
  source.snapshot('s');

  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  let now = 0;
  const timers = [];
  const files = new ProcessFiles(engine, {
    hydration: {
      fetch: async (hashes) => source.exportChunks(hashes, Infinity).chunks,
      batch: 1,
      schedule: 'manual',
      deadlineMs: testCase.deadlineTicks * 1000,
      // The model's asynchronous readers wait without a deadline (the gate's
      // is modeled); FormalModelsLane is adding the reader deadline.
      readDeadlineMs: Infinity,
      now: () => now,
      setTimer: (fire, ms) => { timers.push({ at: now + ms, fire }); },
    },
  });
  const hydrator = files.hydrator;
  for (const root of ['imp', 'app']) {
    if (!Object.keys(testCase.files).some((path) => path.startsWith(`/${root}/`))) continue;
    let after = null;
    for (;;) {
      const page = source.exportPage({ at: 's', root, after });
      const wanted = [...new Set(page.rows.flatMap((row) => row.pieces.map(([hash]) => hash)))].filter((hash) => !remote.has(hash));
      // The engine's import: the job's queue is the case's, set below.
      const result = engine.importPage(root, page, wanted.length > 0 ? source.exportChunks(wanted, Infinity).chunks : [], { lazy: true });
      assert.deepEqual(result.want, []);
      if (page.next === null) break;
      after = page.next;
    }
  }
  // The job's order is the import's: the case names it.
  hydrator.enqueue(testCase.remote.map((name) => hashOf.get(name)));

  const proc = files.bind({ pid: 2, cred: USER });
  const kernelRead = (path) => engine.as(CRED_KERNEL).readFile(path.slice(1));
  const gates = [];
  const waiting = [];
  const failures = [];
  for (const [at, event] of testCase.events.entries()) {
    let got = 'ok';
    switch (event.event) {
      case 'tick': {
        now += 1000;
        for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
          if (timer.at <= now) timer.fire(); else timers.push(timer);
        }
        break;
      }
      case 'job': await hydrator.step(); break;
      case 'asyncRead': {
        if (hydrator.isLocal(event.path)) { kernelRead(event.path); got = 'bytes'; break; }
        const entry = { path: event.path, done: false };
        hydrator.whenLocal(event.path).then(() => { entry.bytes = kernelRead(event.path); entry.done = true; });
        waiting.push(entry);
        got = 'wait';
        break;
      }
      case 'resume': {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const resumed = waiting.filter((entry) => entry.done);
        for (const entry of resumed) {
          const expected = new Uint8Array(testCase.files[entry.path].length * CHUNK);
          testCase.files[entry.path].forEach((name, i) => expected.set(bytesOf(name), i * CHUNK));
          assert.deepEqual(entry.bytes, expected, `${entry.path}: the bytes read after the wait`);
          waiting.splice(waiting.indexOf(entry), 1);
        }
        got = { resumed: resumed.map((entry) => entry.path) };
        break;
      }
      case 'syncRead': {
        try {
          proc.readFile(event.path);
          got = 'bytes';
        } catch (error) {
          got = { error: error.code, path: error.path ?? event.path };
        }
        break;
      }
      case 'bind': {
        const gate = { state: 'waiting' };
        gates.push(gate);
        files.gateLaunch(event.named).then(() => { gate.state = 'ok'; }, (error) => { gate.state = { error: error.code, path: error.path }; });
        break;
      }
      default: throw new Error(`unknown event ${event.event}`);
    }
    await Promise.resolve();
    await Promise.resolve();
    const state = {
      expect: got,
      gates: gates.map((gate) => gate.state),
      queue: hydrator.queued().map((hash) => nameOf.get(hash)),
    };
    const want = { expect: event.expect, gates: event.gates, queue: event.queue };
    try {
      assert.deepEqual(state, want);
    } catch {
      failures.push(`case ${index} event ${at} ${JSON.stringify({ event: event.event, path: event.path, named: event.named })}: got ${JSON.stringify(state)}, model ${JSON.stringify(want)}`);
    }
  }
  return failures;
}

const failures = [];
let events = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  failures.push(...await runCase(testCase, index));
  events += testCase.events.length;
}
if (failures.length > 0) {
  for (const failure of failures.slice(0, 10)) console.log(`FAIL ${failure}`);
  console.log(`n17-hydration-refinement: ${failures.length} of ${events} events disagree with the model`);
  process.exit(1);
}
console.log(`n17-hydration-refinement: ${events} events in ${fixture.cases.length} cases agree with the model`);
