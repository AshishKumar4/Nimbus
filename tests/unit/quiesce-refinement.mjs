#!/usr/bin/env bun
// Refinement bridge for Nimbus.ContentStore.Quiesce (FormalModelsLane
// cdb92992, CS-008; lean/fixtures/quiesce.json). Each case runs on its own
// SqliteVFS: leases, streams (their source held open until `end`, carrying a
// lease's owner or not), restoreAsync and sliced copyTree jobs, and quiesced
// snapshots. After every step the engine settles, and the jobs that started
// (in order) and the snapshots that pinned (with the jobs done at the pin,
// read from the snapshot's own tree) must be the model's.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/quiesce.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every microtask and timer the engine has queued, until nothing moves. */
async function settle(engine, log) {
  let quiet = 0;
  let seen = -1;
  while (quiet < 5) {
    await turn();
    const now = log.length + engine.snapshots().length;
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;
  }
}

async function runCase(testCase) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  const started = [];
  // Observe starts at the engine's own spanning entry points.
  const jobOf = new Map();
  for (const method of ['consumeStream', 'restoreInSlices', 'copyTreeInSlices']) {
    const original = engine[method].bind(engine);
    engine[method] = (first, ...rest) => {
      const id = method === 'consumeStream' ? jobOf.get(first)
        : method === 'restoreInSlices' ? jobOf.get(rest[0]?.subtree)
          : jobOf.get(first.dst);
      started.push(id);
      return original(first, ...rest);
    };
  }
  // Fixed state every job needs: its own path, and for a restore a snapshot of it.
  kernel.mkdir('jobs');
  kernel.mkdir('src');
  for (const step of testCase.steps) if (step.op === 'acquire') kernel.mkdir(`lease${step.lease}`);
  kernel.writeFile('src/f', 'copied');
  const restores = testCase.steps.filter((step) => step.op === 'restore').map((step) => step.id);
  for (const id of restores) kernel.writeFile(`jobs/r${id}`, 'restored');
  engine.snapshot('pre');
  for (const id of restores) kernel.unlink(`jobs/r${id}`);

  const leases = [];
  const results = new Map();
  const sources = new Map();
  const running = [];
  const pinnedNames = new Set(['pre']);
  const paths = new Map();
  const done = (view, id) => view.exists(paths.get(id));
  const kinds = new Map();

  for (const [index, step] of testCase.steps.entries()) {
    const at = `step ${index} ${JSON.stringify({ ...step, expect: undefined })}`;
    const startedBefore = started.length;
    switch (step.op) {
      case 'acquire': leases[step.lease] = engine.acquireExclusiveMutation(`lease${step.lease}`); break;
      case 'release': engine.releaseExclusiveMutation(leases[step.lease].owner); break;
      case 'stream': {
        // A stream under a lease writes inside its lease; any other, under jobs/.
        const dir = step.owner === undefined ? 'jobs' : `lease${step.owner}`;
        const path = `${dir}/s${step.id}`;
        let close;
        const opened = new Promise((resolve) => { close = resolve; });
        // The source's bytes arrive only at `end`: the stream runs until then.
        const frames = encodeWriteBatchStream({
          inodes: [{ path, parentPath: dir, isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 }],
          chunks: [{ path, chunkId: 0, data: enc.encode('s') }],
        }).getReader();
        const stream = new ReadableStream({
          type: 'bytes',
          async pull(controller) {
            await opened;
            const { done: finished, value } = await frames.read();
            if (finished) controller.close();
            else controller.enqueue(value);
          },
        });
        paths.set(step.id, path);
        jobOf.set(stream, step.id);
        sources.set(step.id, close);
        kinds.set(step.id, 's');
        const owner = step.owner === undefined ? undefined : leases[step.owner].owner;
        const run = kernel.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner });
        const outcome = { settled: false, result: undefined };
        run.then((result) => { outcome.settled = true; outcome.result = result; });
        results.set(step.id, outcome);
        running.push(run);
        break;
      }
      case 'end': sources.get(step.job)(); break;
      case 'restore':
        jobOf.set(`jobs/r${step.id}`, step.id);
        paths.set(step.id, `jobs/r${step.id}`);
        kinds.set(step.id, 'r');
        running.push(engine.restoreAsync('pre', { subtree: `jobs/r${step.id}` }));
        break;
      case 'copy':
        jobOf.set(`jobs/c${step.id}`, step.id);
        paths.set(step.id, `jobs/c${step.id}`);
        kinds.set(step.id, 'c');
        running.push(kernel.copyTreeAsync('src', `jobs/c${step.id}`));
        break;
      case 'snapshot': running.push(engine.snapshot(step.name, { quiesce: true })); break;
      default: throw new Error(`${at}: unknown op`);
    }
    await settle(engine, started);
    assert.deepEqual(started.slice(startedBefore), step.expect.started, `${at}: started`);
    const pins = engine.snapshots().filter((snap) => !pinnedNames.has(snap.name));
    for (const snap of pins) pinnedNames.add(snap.name);
    const pinned = pins.map((snap) => {
      const view = engine.at(snap.name);
      const contents = [...kinds].filter(([id]) => done(view, id)).map(([id]) => id).sort((a, b) => a - b);
      return { snapshot: snap.name, contents };
    });
    assert.deepEqual(pinned, step.expect.pinned, `${at}: pinned`);
    if (step.op === 'end') {
      // The model's refused end: an owned stream whose lease is gone writes nothing.
      const { settled, result } = results.get(step.job);
      const refused = !settled || result.ok ? undefined : /ESTALE/.test(`${result.error?.code} ${result.error?.message}`) ? 'ESTALE' : result.error?.code;
      assert.equal(refused, step.refused, `${at}: refused`);
    }
  }
  await Promise.all(running);
}

let failures = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  try {
    await runCase(testCase);
  } catch (error) {
    failures++;
    if (failures <= 5) console.log(`FAIL case ${index}: ${error.message.split('\n')[0]} :: ${JSON.stringify(error.actual)} vs ${JSON.stringify(error.expected)}`);
  }
}
if (failures > 0) {
  console.log(`quiesce-refinement: ${failures} of ${fixture.cases.length} cases disagree with the model`);
  process.exit(1);
}
console.log(`quiesce-refinement: ${fixture.cases.length} cases of lean/fixtures/quiesce.json agree with the model`);
