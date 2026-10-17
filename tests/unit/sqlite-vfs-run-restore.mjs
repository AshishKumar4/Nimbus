#!/usr/bin/env bun
/**
 * sqlite-vfs-run-restore — a run's changes, put back (SqliteVFS.captureRun,
 * restoreRun). A one-shot that listened is run again as a resident from
 * what its first run started from: from captureRun, the first change of
 * each storage key by the run's process keeps what was there, and
 * restoreRun puts every key back as the run found it.
 *
 *   put back: a file rewritten, made, removed, cut short, a directory made
 *     with a file in it, a tree removed whole, a file renamed (both names).
 *     Another process's change is its own and stays.
 *   kept: what the run replaced stays readable, whatever content
 *     maintenance collects meanwhile.
 *   settled: the waves of its epochs still being applied land before it
 *     is put back, and none is admitted after.
 *   refused: another writer changed a key after the run last did, or wrote
 *     into a directory the run made; the run's changes are then left as
 *     they are, and the key is named. So are a capture let go and one past
 *     RUN_CAPTURE_MAX_KEYS.
 *
 * Before: no capture existed. The run again ran over what its first run had
 * changed, and was checked change by change against it, so two tasks that
 * wrote in another order ended it (P1, remix-relaunch-promotion).
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { RUN_CAPTURE_MAX_KEYS, SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const RUN = 41;
const PEER = 42;

function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const files = new ProcessFiles(engine);
  const user = engine.as(CRED_SESSION_USER);
  const next = new Map();
  /** A wave of `ops` by process `pid`, numbered on from its last. */
  const wave = async (pid, ops) => {
    const first = next.get(pid) ?? 1;
    next.set(pid, first + ops.length);
    const answer = await files.waves.writeStream(user, encodeWriteBatchStream({ inodes: [], chunks: [], ops }), {
      sequence: { writer: `w${pid}`, first, ack: first - 1, pid },
    });
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    return answer;
  };
  const text = (key) => { try { return dec.decode(kernel.readFile(key)); } catch { return null; } };
  const ino = (key) => kernel.stat(key).ino;
  const seed = (key, content) => user.writeFile(key, enc.encode(content), { mode: 0o644 });
  return { engine, kernel, user, wave, text, ino, seed };
}

const call = (c) => ({ type: 'call', call: c });
const write = (path, content) => call({ call: 'writeFile', path, mode: 0o644, data: enc.encode(content) });
const mkdir = (path) => call({ call: 'mkdir', path, mode: 0o755 });
const unlink = (path) => call({ call: 'unlink', path });
const rmTree = (path) => call({ call: 'rm', path, recursive: true });
const rename = (from, to) => ({ type: 'rename', from, to });
const truncate = (path, size) => ({ type: 'truncate', path, size });

// ── put back ─────────────────────────────────────────────────────────────
{
  const s = session();
  s.seed('home/user/kept.txt', 'old');
  s.seed('home/user/gone.txt', 'bye');
  s.seed('home/user/cut.txt', 'abcdef');
  s.seed('home/user/moved.txt', 'moving');
  s.user.mkdir('home/user/tree/b', { recursive: true, mode: 0o755 });
  s.seed('home/user/tree/a', 'tree a');
  s.seed('home/user/tree/b/c', 'tree c');
  const before = { kept: s.ino('home/user/kept.txt'), moved: s.ino('home/user/moved.txt'), c: s.ino('home/user/tree/b/c') };

  s.engine.captureRun(RUN);
  await s.wave(RUN, [write('home/user/kept.txt', 'new'), write('home/user/made.txt', 'made'), unlink('home/user/gone.txt')]);
  await s.wave(PEER, [write('home/user/peer.txt', 'its own')]);
  await s.wave(RUN, [truncate('home/user/cut.txt', 2), mkdir('home/user/dir'), write('home/user/dir/f', 'in dir')]);
  await s.wave(RUN, [rmTree('home/user/tree'), rename('home/user/moved.txt', 'home/user/renamed.txt')]);
  // What the run replaced is held while it is kept: collected content stays readable.
  s.engine.runContentMaintenance(64);

  const restored = s.engine.restoreRun(RUN);
  assert.ok('restored' in restored, JSON.stringify(restored));
  assert.equal(s.text('home/user/kept.txt'), 'old', 'a rewritten file has what it had');
  assert.equal(s.ino('home/user/kept.txt'), before.kept, 'and is the same file');
  assert.equal(s.text('home/user/made.txt'), null, 'a file the run made is gone');
  assert.equal(s.text('home/user/gone.txt'), 'bye', 'a file the run removed is back');
  assert.equal(s.text('home/user/cut.txt'), 'abcdef', 'a file the run cut short is whole: its content was copied, not cut in place');
  assert.equal(s.kernel.exists('home/user/dir'), false, 'a directory the run made is gone, with its file');
  assert.equal(s.text('home/user/tree/a'), 'tree a', 'a tree the run removed is back');
  assert.equal(s.text('home/user/tree/b/c'), 'tree c');
  assert.equal(s.ino('home/user/tree/b/c'), before.c);
  assert.equal(s.text('home/user/moved.txt'), 'moving', 'a renamed file is back under its name');
  assert.equal(s.ino('home/user/moved.txt'), before.moved);
  assert.equal(s.text('home/user/renamed.txt'), null, 'and gone from the other');
  assert.equal(s.text('home/user/peer.txt'), 'its own', "another process's change stays");
  // Put back once: it is no longer kept.
  assert.deepEqual(s.engine.restoreRun(RUN), { refused: 'what it changed was not kept' });
  // Its writes from here on are its own, and kept by no one.
  await s.wave(RUN, [write('home/user/made.txt', 'again')]);
  assert.equal(s.text('home/user/made.txt'), 'again');
}

// ── refused: another writer changed a key after the run did ─────────────
{
  const s = session();
  s.seed('home/user/shared.txt', 'base');
  s.engine.captureRun(RUN);
  await s.wave(RUN, [write('home/user/shared.txt', 'run'), write('home/user/own.txt', 'own')]);
  await s.wave(PEER, [write('home/user/shared.txt', 'peer')]);
  const refused = s.engine.restoreRun(RUN);
  assert.ok('refused' in refused);
  assert.match(refused.refused, /^\/home\/user\/shared\.txt was changed since it changed it$/);
  assert.equal(s.text('home/user/shared.txt'), 'peer', "the peer's change stays");
  assert.equal(s.text('home/user/own.txt'), 'own', "and so do the run's: nothing is put back");
}
// … or wrote into a directory the run made.
{
  const s = session();
  s.engine.captureRun(RUN);
  await s.wave(RUN, [mkdir('home/user/made'), write('home/user/made/run.txt', 'r')]);
  await s.wave(PEER, [write('home/user/made/peer.txt', 'p')]);
  const refused = s.engine.restoreRun(RUN);
  assert.match(refused.refused, /^\/home\/user\/made was changed since it changed it$/);
  assert.equal(s.text('home/user/made/peer.txt'), 'p');
}
// … or removed a file the run wrote.
{
  const s = session();
  s.engine.captureRun(RUN);
  await s.wave(RUN, [write('home/user/x.txt', 'r')]);
  await s.wave(PEER, [unlink('home/user/x.txt')]);
  assert.match(s.engine.restoreRun(RUN).refused, /^\/home\/user\/x\.txt was changed since it changed it$/);
}
// A peer that wrote beside the run, in a directory the run only wrote into, changes nothing of the run's.
{
  const s = session();
  s.engine.captureRun(RUN);
  await s.wave(RUN, [write('home/user/a.txt', 'a')]);
  await s.wave(PEER, [write('home/user/b.txt', 'b')]);
  await s.wave(RUN, [write('home/user/c.txt', 'c')]);
  assert.ok('restored' in s.engine.restoreRun(RUN));
  assert.deepEqual([s.text('home/user/a.txt'), s.text('home/user/b.txt'), s.text('home/user/c.txt')], [null, 'b', null]);
}

// ── refused: let go, or past the bound ──────────────────────────────────
{
  const s = session();
  s.engine.captureRun(RUN);
  await s.wave(RUN, [write('home/user/x.txt', 'r')]);
  s.engine.releaseRun(RUN);
  assert.deepEqual(s.engine.restoreRun(RUN), { refused: 'what it changed was not kept' });
  assert.equal(s.text('home/user/x.txt'), 'r');
}
{
  const s = session();
  s.user.mkdir('home/user/many', { mode: 0o755 });
  s.engine.captureRun(RUN);
  const names = Array.from({ length: RUN_CAPTURE_MAX_KEYS + 1 }, (_, i) => `home/user/many/${i}`);
  for (let i = 0; i < names.length; i += 512) await s.wave(RUN, names.slice(i, i + 512).map((name) => write(name, '')));
  assert.deepEqual(s.engine.restoreRun(RUN), { refused: `it changed more than ${RUN_CAPTURE_MAX_KEYS} files and directories` });
  assert.equal(s.text('home/user/many/0'), '', 'nothing is put back');
}

// ── its late waves: settled before it is put back, and none admitted after ──
{
  const deliveries = new SupervisorDeliveries();
  const epochs = [deliveries.openWaveWriter(RUN, 60_000), deliveries.openWaveWriter(RUN, 60_000)];
  const peer = deliveries.openWaveWriter(PEER, 60_000);
  const landing = epochs.map(() => Promise.withResolvers());
  for (const [i, writer] of epochs.entries()) {
    deliveries.admitWave(RUN, writer, 1, 0);
    void deliveries.applyingWave(RUN, writer, landing[i].promise);
  }
  let retired = false;
  const retiring = deliveries.retireWaveWriters(RUN).then(() => { retired = true; });
  assert.throws(() => deliveries.admitWave(RUN, epochs[0], 2, 0), /ESTALE/, 'a wave of its epochs is refused once they are retired');
  deliveries.admitWave(PEER, peer, 1, 0);
  landing[0].resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(retired, false, 'retiring waits for each wave of its epochs being applied');
  landing[1].reject(new Error('cut'));
  await retiring;
  assert.equal(retired, true);
}

console.log('sqlite-vfs-run-restore: a run\'s changes are put back as it found them, or refused, naming why, and none is');
