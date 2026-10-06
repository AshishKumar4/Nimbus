#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.Hydration (FormalModelsLane 1b9c543d,
// lean/fixtures/n17-hydration.json, N17-001). Each case builds its files in
// a source store (one 64 KiB chunk per hash name, the same bytes for the same
// name), and lazily imports them into the session's store under /imp and
// /app with bytes for every hash the case does not leave remote. The
// remote ones stay pending, queued in the case's order. The events then run
// against a Hydrator over the session's store, through a process's bound
// filesystem: a job is one step (fetching from the source), a tick a second
// on a fake clock, an asynchronous read the hydrator's wait followed by a
// read, a synchronous read the bridge's own. After every event the answer,
// the readers, the gates, the queue and the failed hashes must be the
// model's. A job's outcome is the fetch's: ok, reject (it throws), mismatch
// (wrong bytes) or omit (the hash left out).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

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
  // A remote chunk the model names but no file holds is, in the engine, a
  // chunk of a file nobody reads: an import only names chunks its rows hold.
  const held = new Set(Object.values(testCase.files).flat());
  const layout = { ...testCase.files };
  for (const name of testCase.remote) if (!held.has(name)) layout[`/imp/.unread-${name}`] = [name];
  for (const [path, chunks] of Object.entries(layout)) {
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
  const config = testCase.config;
  let outcome = 'ok';
  const files = new ProcessFiles(engine, {
    hydration: {
      fetch: async (hashes) => {
        if (outcome === 'reject') throw new Error('rejected');
        if (outcome === 'omit') return [];
        if (outcome === 'mismatch') return hashes.map((hash) => ({ hash, data: new TextEncoder().encode('wrong') }));
        return source.exportChunks(hashes, Infinity).chunks;
      },
      batch: 1,
      schedule: 'manual',
      deadlineMs: config.deadlineTicks * 1000,
      readDeadlineMs: config.readDeadlineTicks * 1000,
      backoffMs: config.backoffTicks * 1000,
      maxBackoffMs: config.maxBackoffTicks * 1000,
      maxAttempts: config.maxAttempts,
      now: () => now,
      setTimer: (fire, ms) => { timers.push({ at: now + ms, fire }); },
    },
  });
  const hydrator = files.hydrator;
  for (const root of ['imp', 'app']) {
    if (!Object.keys(layout).some((path) => path.startsWith(`/${root}/`))) continue;
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
  const readers = [];
  const failures = [];
  const errorOf = (error) => ({ error: error.code, path: error.path, ...(error.chunk === undefined ? {} : { chunk: nameOf.get(error.chunk) }) });
  const expected = (path) => {
    const out = new Uint8Array(testCase.files[path].length * CHUNK);
    testCase.files[path].forEach((name, i) => out.set(bytesOf(name), i * CHUNK));
    return out;
  };
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
      case 'job': {
        outcome = event.outcome;
        const queued = hydrator.ready()[0];
        const failedBefore = new Set(hydrator.failures().keys());
        const pendingBefore = queued === undefined ? [] : engine.pendingOf([queued]);
        const stepped = await hydrator.step();
        if (!stepped) got = 'idle';
        else if (pendingBefore.length === 0) got = { skipped: nameOf.get(queued) };
        else if (engine.pendingOf([queued]).length === 0) got = { fetched: nameOf.get(queued) };
        else if (hydrator.failures().has(queued) && !failedBefore.has(queued)) got = { failedForGood: nameOf.get(queued) };
        else got = { failed: nameOf.get(queued) };
        break;
      }
      case 'retry': hydrator.retryFailed(); break;
      case 'asyncRead': {
        if (hydrator.isLocal(event.path)) { kernelRead(event.path); got = 'bytes'; break; }
        const failure = hydrator.failureOf(event.path);
        if (failure !== null) { got = errorOf(failure); break; }
        const reader = { state: 'waiting' };
        readers.push(reader);
        hydrator.whenLocal(event.path).then(() => {
          assert.deepEqual(kernelRead(event.path), expected(event.path), `${event.path}: the bytes read after the wait`);
          reader.state = 'ok';
        }, (error) => { reader.state = errorOf(error); });
        got = 'wait';
        break;
      }
      case 'syncRead': {
        try {
          proc.readFile(event.path);
          got = 'bytes';
        } catch (error) {
          got = error.chunk === undefined ? { error: error.code, path: error.path ?? event.path } : errorOf(error);
        }
        break;
      }
      case 'bind': {
        const gate = { state: 'waiting' };
        gates.push(gate);
        files.gateLaunch(event.named).then(() => { gate.state = 'ok'; }, (error) => { gate.state = errorOf(error); });
        break;
      }
      default: throw new Error(`unknown event ${event.event}`);
    }
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const state = {
      expect: got,
      readers: readers.map((reader) => reader.state),
      gates: gates.map((gate) => gate.state),
      queue: hydrator.queued().map((hash) => nameOf.get(hash)),
      failed: [...hydrator.failures().keys()].map((hash) => nameOf.get(hash)),
    };
    const want = { expect: event.expect, readers: event.readers, gates: event.gates, queue: event.queue, failed: event.failed };
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
