#!/usr/bin/env bun
// Stop and replay (packages/worker/src/runtime/stop-replay.ts), its pieces
// apart from workerd: the session's output gate, the stop record, the input
// a stopped run took going back in front of its channel, and the guest half,
// each run of which is a fresh process here as each run of a program is a
// fresh isolate there. sync-stdin-replay-workerd.mjs runs them together.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  ReplayOutputGate,
  STOP_RECORD_PREFIX,
  STOP_REPLAY_SOURCE,
  stopRecordOf,
} from '../../packages/worker/src/runtime/stop-replay.ts';
import { ProcessInputStore } from '../../packages/core/src/runtime/process-input.ts';

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const b64 = (text) => Buffer.from(text).toString('base64');

// ── The output gate ────────────────────────────────────────────────────────
{
  const gate = new ReplayOutputGate();
  assert.equal(dec(gate.take('stdout', enc('READY\n'), 0, 1)), 'READY\n', 'a run\'s chunk is delivered');
  // Run 1 stops with READY\n in flight (it arrived) and more\n never sent:
  // the stop carries both, and only more\n is new.
  const record = {
    v: 1, kind: 'stdin', run: 1, until: 'end',
    out: [{ s: 'stdout', at: 0, b: b64('READY\n') }, { s: 'stdout', at: 6, b: b64('more\n') }],
    prefix: { stdout: b64('READY\nmore\n'), stderr: '' },
  };
  assert.deepEqual(gate.stopped(record).map(({ stream, bytes }) => [stream, dec(bytes)]), [['stdout', 'more\n']]);
  assert.equal(gate.take('stdout', enc('more\n'), 6, 1).byteLength, 0, 'a stopped run\'s late chunk is dropped');
  assert.equal(dec(gate.take('stdout', enc('got\n'), 11, 2)), 'got\n', 'its successor\'s output starts past the prefix');
  assert.equal(dec(gate.take('stdout', enc('got\nnext\n'), 11, 2)), 'next\n', 'a chunk partly delivered is delivered from where it was not');
  assert.equal(dec(gate.take('stderr', enc('warn\n'), 0, 2)), 'warn\n', 'each stream is its own');
}

// ── The stop record ────────────────────────────────────────────────────────
{
  const record = { v: 1, kind: 'stdin', run: 2, until: 'data', taken: b64('ab') };
  assert.deepEqual(stopRecordOf(new Error(STOP_RECORD_PREFIX + JSON.stringify(record))), record);
  assert.deepEqual(stopRecordOf(new Error('Error: ' + STOP_RECORD_PREFIX + JSON.stringify(record))), record, 'wherever the platform puts it in the message');
  assert.equal(stopRecordOf(new Error('Worker exceeded memory limit')), null);
  assert.equal(stopRecordOf(new Error(STOP_RECORD_PREFIX + '{"v":1')), null, 'a cut record is not one');
  assert.equal(stopRecordOf(new Error(STOP_RECORD_PREFIX + '{"v":2,"run":1}')), null);
}

// ── Input going back in front of its channel ───────────────────────────────
{
  const store = new ProcessInputStore({ maxQueuedBytes: 4 });
  store.open(7);
  assert.equal(store.writeBytes(7, enc('cd')).ok, true);
  store.end(7);
  store.unread(7, [{ data: enc('abxyz'), ended: false }]);
  assert.equal(store.writeBytes(7, enc('e')).ok, false, 'an ended channel takes no more writes');
  const first = await store.read(7, 0);
  assert.equal(dec(first.data), 'abxyzcd', 'what was taken comes back first, past the bound, then the rest');
  assert.equal((await store.read(7, 0)).ended, true, 'and the channel still ends');
}

// ── The guest ──────────────────────────────────────────────────────────────
// One run per process: `script` runs with globalThis.__nimbusStopReplay
// installed, `abort` throws what a real ctx.abort would never let the
// program see, and the run prints one JSON line of what it found.
function guest(script, input = '') {
  const program = [
    STOP_REPLAY_SOURCE,
    'const enc = (t) => new TextEncoder().encode(t);',
    'const sr = globalThis.__nimbusStopReplay;',
    'let stopped = null;',
    'const abort = (e) => { stopped = JSON.parse(e.message.slice(' + JSON.stringify(STOP_RECORD_PREFIX.length) + ')); throw "ABORTED"; };',
    `const input = ${JSON.stringify(input)};`,
    '(async () => {',
    script,
    '})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });',
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

// Run 1 draws from every source, prints, reads 3 bytes, then stops for more.
const first = guest(`
  sr.begin(null, abort, false);
  sr.arm(true);
  const draws = [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), performance.now(), [...crypto.getRandomValues(new Uint8Array(4))]];
  const chunk = sr.write('stdout', enc('before ' + JSON.stringify(draws) + '\\n'));
  const read = sr.read(3);
  try { sr.stop('data', 'read', enc('abc')); } catch (e) { if (e !== 'ABORTED') throw e; }
  console.log(JSON.stringify({ draws, read, chunkAt: chunk.at, stopped }));
`);
assert.equal(first.read, 3);
assert.equal(first.stopped.kind, 'stdin');
assert.equal(first.stopped.until, 'data');
assert.equal(first.stopped.run, 1);
assert.equal(Buffer.from(first.stopped.taken, 'base64').toString(), 'abc');
assert.equal(first.stopped.out.length, 1, 'the chunk the session never acknowledged rides the stop');
assert.deepEqual(first.stopped.tape.reads, [3]);
assert.equal(Buffer.from(first.stopped.prefix.stdout, 'base64').toString(), 'before ' + JSON.stringify(first.draws) + '\n');

// Run 2 replays it: the same draws, the same print (dropped), the same read,
// then live ones.
const replay = { run: 2, tape: first.stopped.tape, prefix: first.stopped.prefix };
const second = guest(`
  const replay = JSON.parse(input);
  sr.begin(replay, abort, false);
  sr.arm(false);
  const draws = [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), performance.now(), [...crypto.getRandomValues(new Uint8Array(4))]];
  const dropped = sr.write('stdout', enc('before ' + JSON.stringify(draws) + '\\n'));
  const reads = [sr.read(7), sr.read(9)];
  const fresh = sr.write('stdout', enc('after\\n'));
  const next = [Math.random(), crypto.randomUUID()];
  console.log(JSON.stringify({ draws, dropped, reads, freshAt: fresh.at, freshRun: fresh.run, short: sr.finish(), next }));
`, JSON.stringify(replay));
assert.deepEqual(second.draws, first.draws, 'every draw the stopped run made is drawn again');
assert.equal(second.dropped, null, 'what the stopped run printed is not sent again');
assert.deepEqual(second.reads, [3, 9], 'the stopped run\'s read returns what it did; the next is live');
assert.deepEqual([second.freshAt, second.freshRun], [Buffer.from(first.stopped.prefix.stdout, 'base64').length, 2], 'new output is placed past the prefix, as run 2\'s');
assert.equal(second.short, '');
assert.notEqual(second.next[0], first.draws[0], 'draws past the record are new');

// A replay that prints something else is ended, naming the byte; one that
// prints less is reported at exit.
const diverged = guest(`
  const replay = JSON.parse(input);
  sr.begin(replay, abort, false);
  sr.arm(false);
  try { sr.write('stdout', enc('BEFORE')); } catch (e) { if (e !== 'ABORTED') throw e; }
  const short = (() => { sr.begin(replay, abort, false); sr.arm(false); sr.write('stdout', enc('bef')); return sr.finish(); })();
  console.log(JSON.stringify({ stopped, short }));
`, JSON.stringify(replay));
assert.deepEqual([diverged.stopped.kind, diverged.stopped.stream, diverged.stopped.at], ['diverged', 'stdout', 0]);
assert.match(diverged.short, /printed less when Nimbus ran it again/);

// A run that changed something outside itself cannot stop; reads, a
// read-only open and its own output do not count.
const ledgered = guest(`
  sr.begin(null, abort, false);
  const supervisor = sr.ledger({
    stat: () => 'stat', fsOpen: () => 'open', writeFile: () => 'written', stdout: () => 'out', cpSpawn: () => 'spawned',
  });
  supervisor.writeFile('/during/boot', 'x');
  sr.arm(true);
  supervisor.stat('/a'); supervisor.fsOpen('/a', { read: true }); supervisor.stdout(enc('x'));
  let quiet = null;
  try { quiet = sr.stop('end', 'read', null); } catch (e) { if (e !== 'ABORTED') throw e; }
  console.log(JSON.stringify({ quiet: stopped !== null ? 'stopped' : quiet }));
`);
assert.equal(ledgered.quiet, 'stopped', 'reads and output leave the run replayable; calls before it started do not count');
const changed = guest(`
  sr.begin(null, abort, false);
  const supervisor = sr.ledger({ writeFile: () => 'written', fsOpen: () => 'open' });
  sr.arm(true);
  supervisor.fsOpen('/b', { write: true, create: true });
  supervisor.writeFile('/c', 'x');
  console.log(JSON.stringify({ why: sr.stop('end', 'read', null), stopped }));
`);
assert.equal(changed.stopped, null);
assert.equal(changed.why, 'made a change outside itself first (fsOpen /b), which a second run would make again', 'the first change is named');
const resident = guest(`
  sr.begin(null, null, false);
  sr.arm(true);
  console.log(JSON.stringify({ why: sr.stop('end', 'read', null), random: typeof Math.random() }));
`);
assert.equal(resident.why, 'runs where Nimbus cannot stop it', 'a run with no way to stop says why');

const unarmed = guest(`
  sr.begin(null, abort, false);
  sr.arm(false, 'is a server started from the terminal, whose stdin nothing writes');
  console.log(JSON.stringify({ why: sr.stop('end', 'read', null), random: Math.random() !== Math.random() }));
`);
assert.equal(unarmed.why, 'is a server started from the terminal, whose stdin nothing writes', 'a run armed without a stop says why it has none');

console.log('stop-replay: the gate, the record, the channel and the guest replay a stopped run');
