#!/usr/bin/env bun
// Protocol replies are bounded per run; only observations compare their bytes.
import assert from 'node:assert/strict';
import { ReplaySessions } from '../../packages/worker/src/runtime/replay-session.ts';
import { REPLAY_JOURNAL_MAX_ENTRIES } from '../../packages/worker/src/runtime/stop-replay-contracts.ts';

function world() {
  const replay = new ReplaySessions();
  const divergences = [];
  const { journal } = replay.open(7, (why) => divergences.push(why));
  journal.start('first');
  return { replay, journal, divergences };
}

async function replies(replay, run, count) {
  const input = { data: new Uint8Array([65]), ended: false };
  for (let i = 0; i < count; i++) {
    const op = ['cpReadStdin', 'stdout', 'cpBlocked'][i % 3];
    const value = op === 'cpReadStdin' ? input : undefined;
    assert.equal(await replay.call(op, [], 7, run, async () => value), value);
  }
}

const cases = [
  ['limit boundary', async () => {
    const { replay, journal } = world();
    try {
      await replies(replay, 'first', REPLAY_JOURNAL_MAX_ENTRIES - 1);
      assert.equal(journal.replayable, true);
      await replies(replay, 'first', 1);
      assert.equal(journal.replayable, true, 'the last allowed reply disqualified the run');
      await replies(replay, 'first', 1);
      assert.equal(journal.replayable, false, 'the first excess reply left the run replayable');
    } finally { replay.close(7); }
  }],
  ['authorized preparation counts without checking the limit', async () => {
    const { replay, journal } = world();
    journal.bindStdinFile({ path: '/input', offset: 0, limit: 2 });
    journal.start('first');
    try {
      await replies(replay, 'first', REPLAY_JOURNAL_MAX_ENTRIES - 1);
      for (const offset of [0, 1]) {
        const value = { data: new Uint8Array([65 + offset]), size: 2 };
        assert.equal(await replay.call('stdinFileRead', ['/input', offset, 1], 7, 'first', async () => value), value);
        assert.equal(journal.replayable, true, 'authorized preparation enforced the ordinary reply limit');
      }
      await replies(replay, 'first', 1);
      assert.equal(journal.replayable, false, 'preparation replies did not count toward the next ordinary reply');
    } finally { replay.close(7); }
  }],
  ['stop/start resets the limit', async () => {
    const { replay, journal } = world();
    try {
      for (const run of ['first', 'second', 'third']) {
        if (run !== 'first') {
          journal.stopped();
          journal.start(run);
          await replay.boundary(7, run);
        }
        await replies(replay, run, REPLAY_JOURNAL_MAX_ENTRIES);
        assert.equal(journal.replayable, true, `${run} inherited another run's reply count`);
      }
      await replies(replay, 'third', 1);
      assert.equal(journal.replayable, false);
    } finally { replay.close(7); }
  }],
  ['observations still compare all bytes', async () => {
    for (const changed of [false, true]) {
      const { replay, journal, divergences } = world();
      try {
        const bytes = new Uint8Array(65536).fill(65);
        await replay.call('readFileBytes', ['/observed'], 7, 'first', async () => bytes);
        journal.stopped();
        journal.start('second');
        const next = bytes.slice();
        if (changed) next[next.length - 1] = 66;
        const answer = replay.call('readFileBytes', ['/observed'], 7, 'second', async () => next);
        if (changed) {
          await assert.rejects(answer);
          assert.equal(divergences.length, 1);
          assert.notEqual(journal.diverged, null);
        } else {
          assert.deepEqual(await answer, bytes);
          await replay.boundary(7, 'second');
          assert.equal(journal.replayable, true);
          assert.deepEqual(divergences, []);
        }
      } finally { replay.close(7); }
    }
  }],
];

for (const [name, run] of cases) {
  try { await run(); console.log(`ok ${name}`); }
  catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}
