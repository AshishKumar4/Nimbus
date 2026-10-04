#!/usr/bin/env bun
// Stop and replay (packages/worker/src/runtime/stop-replay.ts), its pieces
// apart from workerd: the session's output gate and its own account of what
// a run took from stdin, the stop record and what makes one believable, input
// going back in front of a channel, and the guest half, each run of which is
// a fresh process here as each run of a program is a fresh isolate there.
// sync-stdin-replay-workerd.mjs runs them together.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  OwnedPieces,
  ReplayOutputGate,
  StdinTaken,
  STOP_RECORD_PREFIX,
  STOP_REPLAY_SOURCE,
  stopRecordOf,
} from '../../packages/worker/src/runtime/stop-replay.ts';
import { ProcessInputStore } from '../../packages/core/src/runtime/process-input.ts';

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const b64 = (text) => Buffer.from(text).toString('base64');
const NONCE = 'c0ffee00-1111-4222-8333-444455556666';
const TAPE = { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [], obs: [] };

// ── The output gate: what the session showed is the prefix ─────────────────
{
  const gate = new ReplayOutputGate();
  assert.equal(dec(gate.take('stdout', enc('READY\n'), 0, 1)), 'READY\n');
  assert.equal(dec(gate.take('stderr', enc('warn\n'), 0, 1)), 'warn\n');
  // Run 1 stops with READY\n in flight (it arrived) and more\n never sent:
  // the stop carries both, and only more\n is new.
  const { fresh, prefix } = gate.stopped({
    v: 2, kind: 'stdin', run: 1, until: 'end', stopAt: 0, tape: TAPE,
    out: [{ s: 'stdout', at: 0, b: b64('READY\n') }, { s: 'stdout', at: 6, b: b64('more\n') }],
  });
  assert.deepEqual(fresh.map(({ stream, bytes }) => [stream, dec(bytes)]), [['stdout', 'more\n']]);
  assert.deepEqual([dec(prefix.stdout), dec(prefix.stderr)], ['READY\nmore\n', 'warn\n'], 'the prefix is what was shown, on each stream');
  assert.equal(gate.take('stdout', enc('more\n'), 6, 1).byteLength, 0, 'a stopped run\'s late chunk is dropped');
  assert.equal(dec(gate.take('stdout', enc('got\n'), 11, 2)), 'got\n', 'its successor\'s output starts past the prefix');
  // More shown than a run can be checked against: no prefix.
  const big = new ReplayOutputGate();
  big.take('stdout', new Uint8Array(1024 * 1024 + 1), 0, 1);
  assert.equal(big.stopped({ v: 2, kind: 'stdin', run: 1, until: 'end', stopAt: 0, tape: TAPE, out: [] }).prefix, null);
}

// ── A stop record counts only with the run's nonce, and only in its shape ───
{
  const record = { v: 2, kind: 'stdin', run: 2, until: 'data', stopAt: 3, tape: TAPE, out: [] };
  const message = (r, nonce = NONCE) => new Error(STOP_RECORD_PREFIX + nonce + ' ' + JSON.stringify(r));
  assert.deepEqual(stopRecordOf(message(record), NONCE, 2), record);
  assert.deepEqual(stopRecordOf(new Error('Error: ' + message(record).message), NONCE, 2), record, 'wherever the platform puts it in the message');
  assert.equal(stopRecordOf(message(record, 'not-this-runs-nonce-0000000000'), NONCE, 2), null, 'another nonce: not this run\'s stop');
  assert.equal(stopRecordOf(new Error(STOP_RECORD_PREFIX + JSON.stringify(record)), NONCE, 2), null, 'no nonce: forged');
  assert.equal(stopRecordOf(message(record), NONCE, 3), null, 'another run');
  assert.equal(stopRecordOf(message(record), 'short', 2), null, 'a nonce too short to be one');
  for (const [what, broken] of [
    ['an older shape', { ...record, v: 1 }],
    ['an unknown kind', { ...record, kind: 'other' }],
    ['no tape', { ...record, tape: undefined }],
    ['a tape seed of three words', { ...record, tape: { ...TAPE, seed: [1, 2, 3] } }],
    ['random bytes that are not base64', { ...record, tape: { ...TAPE, random: '***' } }],
    ['a read of a negative length', { ...record, tape: { ...TAPE, reads: [-1] } }],
    ['output on a third stream', { ...record, out: [{ s: 'stdlog', at: 0, b: '' }] }],
    ['output too long to be one', { ...record, out: [{ s: 'stdout', at: 0, b: 'A'.repeat(4 * 1024 * 1024) }] }],
    ['a divergence without its reason', { v: 2, kind: 'diverged', run: 2, out: [] }],
  ]) {
    assert.equal(stopRecordOf(message(broken), NONCE, 2), null, what);
  }
  assert.equal(stopRecordOf(new Error('Worker exceeded memory limit'), NONCE, 1), null);
}

// ── What a run took from stdin: only the current run takes ─────────────────
{
  let held = 0;
  const hold = { take: (n) => { held += n; return n; }, give: (n = held) => { held -= n; } };
  const taken = new StdinTaken(hold, 10);
  assert.equal(taken.admits('w1'), true, 'before any run starts, any reader');
  taken.start('w1');
  assert.equal(taken.admits('w1'), true);
  assert.equal(taken.admits('w0'), false, 'a stopped run\'s read takes nothing');
  taken.note(enc('abc'));
  taken.note(enc('de'));
  taken.retire();
  assert.equal(taken.admits('w1'), false, 'once stopped, its reads take nothing either');
  const back = taken.take();
  assert.deepEqual([dec(back.chunks[0]), back.bytes, held], ['abcde', 5, 5], 'what it took, still held against the budget');
  taken.start('w2');
  taken.note(enc('0123456789AB'));
  assert.equal(taken.take(), null, 'past the limit: no stop can hand it back');
}

// ── Input coalesced, and going back in front of its channel ─────────────────
{
  const pieces = new OwnedPieces();
  const one = new Uint8Array([120]);
  for (let i = 0; i < 200_000; i++) pieces.add(one);
  const owned = pieces.finish();
  assert.equal(pieces.bytes, 200_000);
  assert.deepEqual(owned.map((p) => p.byteLength), [65536, 65536, 65536, 3392], 'two hundred thousand one-byte writes are four pieces');

  const store = new ProcessInputStore({ maxQueuedBytes: 4 });
  store.open(7);
  assert.equal(store.writeBytes(7, enc('cd')).ok, true);
  store.end(7);
  store.unread(7, [{ data: enc('abxyz'), ended: false }]);
  assert.equal(store.writeBytes(7, enc('e')).ok, false, 'an ended channel takes no more writes');
  assert.equal(dec((await store.read(7, 0)).data), 'abxyzcd', 'what was taken comes back first, past the bound, then the rest');
  assert.equal((await store.read(7, 0)).ended, true, 'and the channel still ends');

  // Many packets back at once: no argument spread to overflow.
  const many = new ProcessInputStore();
  many.open(8);
  many.unread(8, Array.from({ length: 200_000 }, () => ({ data: one, ended: false })));
  assert.equal((await many.read(8, 0)).data.byteLength, 200_000, 'two hundred thousand packets go back, and leave as one');

  // A reader already waiting takes what comes back.
  const waiting = new ProcessInputStore();
  waiting.open(9);
  const read = waiting.read(9, 5000);
  waiting.unread(9, [{ data: enc('back'), ended: false }]);
  assert.equal(dec((await read).data), 'back');
}

// ── The guest ──────────────────────────────────────────────────────────────
// One run per process: `script` runs with the module-private
// __nimbusStopReplay in scope, `abort` throws what a real ctx.abort would
// never let the program see, and the run prints one JSON line.
function guest(script, input = '') {
  const program = [
    STOP_REPLAY_SOURCE,
    'const enc = (t) => new TextEncoder().encode(t);',
    'const sr = __nimbusStopReplay;',
    `const NONCE = ${JSON.stringify(NONCE)};`,
    'let stopped = null;',
    `const abort = (e) => { const m = e.message; stopped = JSON.parse(m.slice(m.indexOf(NONCE) + NONCE.length + 1)); throw "ABORTED"; };`,
    'const aborts = (f) => { try { f(); } catch (e) { if (e !== "ABORTED") throw e; } };',
    `const input = ${JSON.stringify(input)};`,
    '(async () => {',
    script,
    '})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });',
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

// The control is the runner module's own: a program finds nothing to call.
assert.deepEqual(guest('console.log(JSON.stringify({ global: typeof globalThis.__nimbusStopReplay, local: typeof sr.block }));'),
  { global: 'undefined', local: 'function' });

// Run 1 draws from every source, observes a file, prints on both streams,
// reads 3 bytes, then stops for more.
const first = guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  sr.arm(true);
  const draws = [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), performance.now(), [...crypto.getRandomValues(new Uint8Array(4))]];
  sr.observe('readFileSync', 'config v1');
  const out = sr.write('stdout', enc('before ' + JSON.stringify(draws) + '\\n'));
  sr.write('stderr', enc('warn\\n'));
  const read = sr.readSome(3, false);
  aborts(() => sr.block('data', 'read'));
  console.log(JSON.stringify({ draws, read, outAt: out.at, stopped }));
`);
assert.equal(first.read, 3);
assert.deepEqual([first.stopped.v, first.stopped.kind, first.stopped.until, first.stopped.run, first.stopped.stopAt], [2, 'stdin', 'data', 1, 1]);
assert.equal(first.stopped.out.length, 2, 'what the session never acknowledged rides the stop');
assert.deepEqual(first.stopped.tape.reads, [3]);
assert.equal(first.stopped.tape.obs.length, 1);
assert.notEqual(stopRecordOf(new Error(STOP_RECORD_PREFIX + NONCE + ' ' + JSON.stringify(first.stopped)), NONCE, 1), null, 'what the guest stops with is a record the session believes');

const prefix = { stdout: b64('before ' + JSON.stringify(first.draws) + '\n'), stderr: b64('warn\n') };
const replay = { run: 2, tape: first.stopped.tape, stopAt: 1, prefix };
const replayed = (script, launch = replay) => guest(`
  const replay = JSON.parse(input);
  sr.begin({ replay, abort, captured: false, nonce: NONCE });
  sr.arm(false);
  const draws = () => [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), performance.now(), [...crypto.getRandomValues(new Uint8Array(4))]];
  ${script}
`, JSON.stringify(launch));

// Run 2 replays it: the same draws, observation, output (dropped) and read;
// at the boundary it goes on, live.
const second = replayed(`
  const d = draws();
  sr.observe('readFileSync', 'config v1');
  const dropped = [sr.write('stdout', enc('before ' + JSON.stringify(d) + '\\n')), sr.write('stderr', enc('warn\\n'))];
  const reads = [sr.readSome(7, false), sr.readSome(9, true)];
  const fresh = sr.write('stdout', enc('after\\n'));
  console.log(JSON.stringify({ d, dropped, reads, freshAt: fresh.at, freshRun: fresh.run, short: sr.finish(), next: Math.random() }));
`);
assert.deepEqual(second.d, first.draws, 'every draw the stopped run made is drawn again');
assert.deepEqual(second.dropped, [null, null], 'what the stopped run printed is not sent again');
assert.deepEqual(second.reads, [3, 9], 'the stopped run\'s read returns what it did; past the boundary, what is there');
assert.deepEqual([second.freshAt, second.freshRun], [Buffer.from(prefix.stdout, 'base64').length, 2]);
assert.equal(second.short, '');

// A replay is ended, before it shows or does anything, when it does not
// retrace the run before it:
const divergence = (script) => replayed(`aborts(() => { const d = draws(); ${script} }); console.log(JSON.stringify({ stopped }));`).stopped;
const writes = `sr.observe('readFileSync', 'config v1'); sr.write('stdout', enc('before ' + JSON.stringify(d) + '\\n'));`;
//   it observes a changed file (the config it read changed while it waited);
assert.match(divergence(`sr.observe('readFileSync', 'config v2');`).why, /readFileSync is not what the run before it saw/);
//   it prints new output on one stream before the other has caught up;
assert.match(divergence(`${writes} sr.write('stdout', enc('C\\n'));`).why, /printed more to stdout than the run before/);
//   it reaches the read with a stream short of what was shown;
assert.match(divergence(`${writes} sr.readSome(3, false); sr.readSome(5, false);`).why, /had printed 5 bytes to stderr and this one 0/);
//   it does something outside itself the run before it did not;
assert.match(divergence(`sr.effect('writeFile /x');`).why, /did something outside itself before the read/);
//   it waits at a read the run before it did not wait at.
assert.match(divergence(`${writes} sr.write('stderr', enc('warn\\n')); sr.readSome(0, false); sr.block('data', 'read');`).why, /its read of stdin found less/);
const diverged = divergence(`sr.observe('readFileSync', 'config v2');`);
assert.equal(diverged.kind, 'diverged');
assert.notEqual(stopRecordOf(new Error(STOP_RECORD_PREFIX + NONCE + ' ' + JSON.stringify(diverged)), NONCE, 2), null);

// A replay that ends, or a resident that finishes booting, before the read it
// stopped at did not retrace its run.
const unfinished = replayed(`console.log(JSON.stringify({ finish: sr.finish(), booted: sr.booted() }));`);
assert.match(unfinished.finish, /ended before the read of stdin it stopped at/);
assert.match(unfinished.booted, /finished starting before the read of stdin it stopped at/);

// A run that did something outside itself cannot stop; reads, a read-only
// open and its own output do not count, nor does anything before it started.
const ledgered = guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  const supervisor = sr.ledger({ stat: () => 'stat', fsOpen: () => 'open', writeFile: () => 'written', stdout: () => 'out', cpSpawn: () => 'spawned' });
  supervisor.writeFile('/during/boot', 'x');
  sr.arm(true);
  supervisor.stat('/a'); supervisor.fsOpen('/a', { read: true }); supervisor.stdout(enc('x'));
  aborts(() => sr.block('end', 'read'));
  console.log(JSON.stringify({ stopped: stopped !== null }));
`);
assert.equal(ledgered.stopped, true);
const changed = guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  const supervisor = sr.ledger({ writeFile: () => 'written', fsOpen: () => 'open', anythingNew: () => 'new' });
  sr.arm(true);
  supervisor.anythingNew('/z');
  supervisor.writeFile('/c', 'x');
  console.log(JSON.stringify({ why: sr.block('end', 'read'), stopped }));
`);
assert.equal(changed.stopped, null);
assert.equal(changed.why, 'did something outside itself first (anythingNew /z), which a second run would do again', 'an unknown call counts, and the first is named');
assert.equal(guest(`
  sr.begin({ replay: null, abort: null, captured: false, nonce: NONCE });
  sr.arm(true);
  console.log(JSON.stringify({ why: sr.block('end', 'read') }));
`).why, 'runs where Nimbus cannot stop it');
assert.equal(guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  sr.arm(false, 'is a server started from the terminal, whose stdin nothing writes');
  console.log(JSON.stringify({ why: sr.block('end', 'read') }));
`).why, 'is a server started from the terminal, whose stdin nothing writes');

// Captured output rides the stop, so an exit that does not run it again
// still hands it back.
const captured = guest(`
  let stdout = '', stderr = '';
  sr.begin({ replay: null, abort, captured: true, capturedText: () => ({ stdout, stderr }), nonce: NONCE });
  sr.arm(true);
  stdout += 'before\\n';
  aborts(() => sr.block('end', 'read'));
  const first = stopped;
  const big = guest2();
  console.log(JSON.stringify({ stopped: first, big }));
  function guest2() {
    stopped = null;
    stdout = 'x'.repeat(1024 * 1024 + 1);
    sr.begin({ replay: null, abort, captured: true, capturedText: () => ({ stdout, stderr }), nonce: NONCE });
    sr.arm(true);
    return sr.block('end', 'read');
  }
`);
assert.equal(Buffer.from(captured.stopped.captured.stdout, 'base64').toString(), 'before\n');
assert.match(captured.big, /printed more than 1048576 bytes first/, 'more captured output than a stop can keep: no stop');

console.log('stop-replay: the gate, the account, the record, the channel and the guest replay a stopped run, and refuse one that does not retrace it');
