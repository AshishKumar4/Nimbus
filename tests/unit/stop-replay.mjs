#!/usr/bin/env bun
// Stop and replay (packages/worker/src/runtime/stop-replay.ts), its pieces
// apart from workerd: the session's output gate, its own account of what a
// run took from stdin, and its journal of what each run was answered; the
// stop record and what makes one believable; input going back in front of a
// channel; and the guest half, each run of which is a fresh process here as
// each run of a program is a fresh isolate there.
// sync-stdin-replay-workerd.mjs runs them together.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  OwnedPieces,
  ReplayOutputGate,
  StdinTaken,
  stopRecordOf,
} from '../../packages/worker/src/runtime/stop-replay-host.ts';
import { answerDigest, callKey, ReplayJournal } from '../../packages/worker/src/runtime/stop-replay-journal.ts';
import { STOP_REPLAY_SOURCE } from '../../packages/worker/src/runtime/stop-replay.ts';
import { STOP_RECORD_PREFIX } from '../../packages/worker/src/runtime/stop-replay-contracts.ts';
import { operationPolicy } from '../../packages/worker/src/runtime/stop-replay-policy.ts';
import { ProcessInputStore } from '../../packages/core/src/runtime/process-input.ts';

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const b64 = (text) => Buffer.from(text).toString('base64');
const NONCE = 'c0ffee00-1111-4222-8333-444455556666';
const TAPE = { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [] };

// ── The output gate: what the session showed is the prefix ─────────────────
{
  const gate = new ReplayOutputGate();
  assert.equal(dec(gate.take('stdout', enc('READY\n'), 0, 1)), 'READY\n');
  assert.equal(dec(gate.take('stderr', enc('warn\n'), 0, 1)), 'warn\n');
  // Run 1 stops with READY\n in flight (it arrived) and more\n never sent:
  // the stop carries both, and only more\n is new.
  const { fresh, prefix } = gate.stopped({
    v: 3, kind: 'stdin', run: 1, until: 'end', stopAt: 0, tape: TAPE,
    out: [{ s: 'stdout', at: 0, b: b64('READY\n') }, { s: 'stdout', at: 6, b: b64('more\n') }],
  });
  assert.deepEqual(fresh.map(({ stream, bytes }) => [stream, dec(bytes)]), [['stdout', 'more\n']]);
  assert.deepEqual([dec(prefix.stdout), dec(prefix.stderr)], ['READY\nmore\n', 'warn\n'], 'the prefix is what was shown, on each stream');
  assert.equal(gate.take('stdout', enc('more\n'), 6, 1).byteLength, 0, 'a stopped run\'s late chunk is dropped');
  assert.equal(dec(gate.take('stdout', enc('got\n'), 11, 2)), 'got\n', 'its successor\'s output starts past the prefix');
  // More shown than a run can be checked against: no prefix.
  const big = new ReplayOutputGate();
  big.take('stdout', new Uint8Array(1024 * 1024 + 1), 0, 1);
  assert.equal(big.stopped({ v: 3, kind: 'stdin', run: 1, until: 'end', stopAt: 0, tape: TAPE, out: [] }).prefix, null);
}

// ── A stop record counts only with the run's nonce, and only in its shape ───
{
  const record = { v: 3, kind: 'stdin', run: 2, until: 'data', stopAt: 3, tape: TAPE, out: [] };
  const message = (r, nonce = NONCE) => new Error(STOP_RECORD_PREFIX + nonce + ' ' + JSON.stringify(r));
  assert.deepEqual(stopRecordOf(message(record), NONCE, 2), record);
  assert.deepEqual(stopRecordOf(new Error('Error: ' + message(record).message), NONCE, 2), record, 'wherever the platform puts it in the message');
  assert.equal(stopRecordOf(message(record, 'not-this-runs-nonce-0000000000'), NONCE, 2), null, 'another nonce: not this run\'s stop');
  assert.equal(stopRecordOf(new Error(STOP_RECORD_PREFIX + JSON.stringify(record)), NONCE, 2), null, 'no nonce: forged');
  assert.equal(stopRecordOf(message(record), NONCE, 3), null, 'another run');
  assert.equal(stopRecordOf(message(record), 'short', 2), null, 'a nonce too short to be one');
  for (const [what, broken] of [
    ['an older shape', { ...record, v: 2 }],
    ['an unknown kind', { ...record, kind: 'other' }],
    ['no tape', { ...record, tape: undefined }],
    ['a tape seed of three words', { ...record, tape: { ...TAPE, seed: [1, 2, 3] } }],
    ['random bytes that are not base64', { ...record, tape: { ...TAPE, random: '***' } }],
    ['a read of a negative length', { ...record, tape: { ...TAPE, reads: [-1] } }],
    ['output on a third stream', { ...record, out: [{ s: 'stdlog', at: 0, b: '' }] }],
    ['output too long to be one', { ...record, out: [{ s: 'stdout', at: 0, b: 'A'.repeat(4 * 1024 * 1024) }] }],
    ['a divergence without its reason', { v: 3, kind: 'diverged', run: 2, out: [] }],
    ['captured output that is not text', { ...record, captured: { stdout: 1, stderr: '' } }],
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

// ── The session's journal ──────────────────────────────────────────────────
{
  const diverged = [];
  const make = () => new ReplayJournal((why) => diverged.push(why), 300);
  const ask = (j, op, args, answer, run = 'r1') => j.handle(op, args, run, () => Promise.resolve(answer));
  // Run 1 is answered two reads, the second a response still pending when it stops.
  const j = make();
  j.start('r1');
  assert.equal(await ask(j, 'readFile', ['/cfg'], 'ABCD'), 'ABCD');
  let slow;
  const pending = j.handle('fsRead', [3, 0, 4], 'r1', () => new Promise((r) => { slow = r; }));
  pending.catch(() => {});
  j.stopped();
  slow(new Uint8Array([1]));
  await assert.rejects(pending, /stopped/, 'nothing a stopped run asked for is answered');
  await assert.rejects(ask(j, 'readFile', ['/cfg'], 'ABCD', 'r1'), /stopped/, 'a stopped run\'s late call takes nothing');

  // N3/N4: run 2 is answered a same-length change: it strays, loudly.
  j.start('r2');
  await assert.rejects(ask(j, 'readFile', ['/cfg'], 'WXYZ', 'r2'), /answered differently/);
  assert.match(diverged.at(-1), /readFile \/cfg was answered differently/);

  // N6: a request pending at the stop is not answered before the boundary.
  const k = make();
  k.start('a');
  await ask(k, 'readFile', ['/x'], 'X', 'a');
  const never = k.handle('readFile', ['/slow'], 'a', () => new Promise(() => {}));
  never.catch(() => {});
  k.stopped();
  k.start('b');
  await ask(k, 'readFile', ['/x'], 'X', 'b');
  let early = false;
  const slowAgain = ask(k, 'readFile', ['/slow'], 'S', 'b').then((v) => { early = true; return v; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(early, false, 'the request pending at the stop waits for the boundary');
  await k.boundary('b');
  assert.equal(await slowAgain, 'S');

  // A replay that gets to the read before an answer the run before had by
  // then (a prefetch it does not wait for) has asked for it: the boundary
  // passes, and the answer is still checked when it comes. One that never
  // asked strays at the boundary.
  const q = make();
  q.start('a');
  await ask(q, 'fsReadBatch', [['/.rc']], 'RC', 'a');
  q.stopped();
  q.start('b');
  let late;
  const prefetch = q.handle('fsReadBatch', [['/.rc']], 'b', () => new Promise((r) => { late = r; }));
  const seen = diverged.length;
  const reached = q.boundary('b');
  assert.equal(diverged.length, seen, 'an answer on its way at the boundary is not a stray');
  late('RC');
  assert.equal(await prefetch, 'RC');
  await reached;
  const n = make();
  n.start('a');
  await ask(n, 'fsReadBatch', [['/.rc']], 'RC', 'a');
  n.stopped();
  n.start('b');
  await assert.rejects(n.boundary('b'), /without asking for everything/);
  assert.match(diverged.at(-1), /without asking for everything .* \(0 of 1\)/);

  // Only fd-0 preparation is input; ordinary reads of that path are observations.
  const i = make();
  i.start('a');
  i.stopped();
  i.start('b');
  const seenBefore = diverged.length;
  await ask(i, 'stdinFileRead', ['/home/user/w/lock.json', 0, 9], { data: enc('LOCK'), size: 4 }, 'b');
  await i.boundary('b');
  assert.equal(diverged.length, seenBefore, 'fd-0 preparation is input');
  const mixed = make();
  mixed.start('a');
  mixed.stopped();
  mixed.start('b');
  await assert.rejects(ask(mixed, 'fsReadBatch', [[{ path: 'home/user/w/lock.json' }, { path: 'home/user/w/other' }]], 'X', 'b'), /did not ask for there/);

  // Answers come back in the order the run before was answered.
  const o = make();
  o.start('a');
  await ask(o, 'stat', ['/1'], 1, 'a');
  await ask(o, 'stat', ['/2'], 2, 'a');
  o.stopped();
  o.start('b');
  const order = [];
  const second = ask(o, 'stat', ['/2'], 2, 'b').then(() => order.push(2));
  await new Promise((r) => setTimeout(r, 20));
  const first = ask(o, 'stat', ['/1'], 1, 'b').then(() => order.push(1));
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2], 'the second answer waits for the first');

  // A replay that never asks again for what came first strays at the stall bound.
  const w = make();
  w.start('a');
  await ask(w, 'stat', ['/1'], 1, 'a');
  await ask(w, 'stat', ['/2'], 2, 'a');
  w.stopped();
  w.start('b');
  const before = diverged.length;
  await assert.rejects(ask(w, 'stat', ['/2'], 2, 'b'), /did not ask again/);
  assert.equal(diverged.length, before + 1);

  // Effects: before the boundary a replay strays; otherwise the run cannot be
  // replayed and nothing more is recorded for it (D1).
  const e = make();
  e.start('a');
  let dispatched = 0;
  await e.handle('writeFile', ['/out', 'x'], 'a', async () => { dispatched++; return 1; });
  assert.equal(e.replayable, false);
  assert.match(e.unreplayable, /writeFile \/out/);
  assert.equal(e.recording, false, 'nothing more is journaled: the outbound goes straight out');
  await ask(e, 'readFile', ['/after'], 'A', 'a');
  e.stopped();
  e.start('b');
  await e.handle('readFile', ['/whatever'], 'b', async () => 'Q').then(() => assert.fail('a replay of an unrecorded run asked for something it never asked for'), () => {});
  const f = make();
  f.start('a');
  assert.equal(f.recording, true);
  f.stopped();
  f.start('b');
  assert.equal(f.recording, true, 'a run after a stop is checked up to its boundary');
  await assert.rejects(f.handle('writeFile', ['/out', 'x'], 'b', async () => { dispatched++; return 1; }), /did something outside itself before the read/);
  assert.equal(dispatched, 1, 'an effect before the boundary is not performed');
  // A read-only open is a read; a writing one is not.
  const g = make();
  g.start('a');
  await g.handle('fsOpen', ['/r', { read: true }], 'a', async () => ({ fd: 3 }));
  assert.equal(g.replayable, true);
  await g.handle('fsOpen', ['/w', { write: true, create: true }], 'a', async () => ({ fd: 4 }));
  assert.match(g.unreplayable, /fsOpen \/w for writing/);
  // Operation-local coherence tokens do not count; timestamps do.
  const project = operationPolicy('fsAcquire').answer;
  assert.equal(answerDigest(project({ rev: 1, epoch: 'a', paths: [] })), answerDigest(project({ rev: 9, epoch: 'b', paths: [] })));
  assert.notEqual(answerDigest({ atime: 1 }), answerDigest({ atime: 9 }));
  assert.notEqual(answerDigest(new Uint8Array([65, 66, 67, 68])), answerDigest(new Uint8Array([87, 88, 89, 90])));
  assert.notEqual(callKey('fsRead', [3, 0, 4]), callKey('fsRead', [3, 4, 4]), 'a read at another offset is another call');
}

// ── The guest ──────────────────────────────────────────────────────────────
// One run per process: `script` runs with the module-private
// __nimbusStopReplay in scope, `abort` records the string a real ctx.abort is
// handed (and throws what a real one would never let the program see), and
// the run prints one JSON line.
function guest(script, input = '') {
  const program = [
    STOP_REPLAY_SOURCE,
    'const enc = (t) => new TextEncoder().encode(t);',
    'const sr = __nimbusStopReplay;',
    `const NONCE = ${JSON.stringify(NONCE)};`,
    'let stopped = null, reason = null;',
    `const abort = (r) => { reason = r; stopped = JSON.parse(r.slice(r.indexOf(NONCE) + NONCE.length + 1)); throw "ABORTED"; };`,
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

// Run 1 draws from every source, prints on both streams, reads 3 bytes, then
// stops for more.
const first = guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  sr.arm(true);
  const draws = [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), performance.now(), [...crypto.getRandomValues(new Uint8Array(4))]];
  sr.write('stdout', enc('before ' + JSON.stringify(draws) + '\\n'));
  sr.write('stderr', enc('warn\\n'));
  const read = sr.readSome(3, false);
  aborts(() => sr.block('data', 'read'));
  console.log(JSON.stringify({ draws, read, stopped, reasonType: typeof reason }));
`);
assert.equal(first.read, 3);
assert.equal(first.reasonType, 'string', 'ctx.abort is handed a string');
assert.deepEqual([first.stopped.v, first.stopped.kind, first.stopped.until, first.stopped.run, first.stopped.stopAt], [3, 'stdin', 'data', 1, 1]);
assert.equal(first.stopped.out.length, 2, 'what the session never acknowledged rides the stop');
assert.deepEqual(first.stopped.tape.reads, [3]);
assert.notEqual(stopRecordOf(new Error(STOP_RECORD_PREFIX + NONCE + ' ' + JSON.stringify(first.stopped)), NONCE, 1), null, 'what the guest stops with is a record the session believes');

// N1: nothing the program can replace is called while the nonce is in hand.
const hostile = guest(`
  sr.begin({ replay: null, abort, captured: true, capturedText: () => ({ stdout: 'printed "so far"\\n', stderr: '' }), nonce: NONCE });
  sr.arm(true);
  Math.random(); Date.now(); crypto.getRandomValues(new Uint8Array(7));
  sr.readSome(2, false);
  const calls = [];
  const saw = (what) => { calls[calls.length] = what; };
  const saved = {
    stringify: JSON.stringify, parse: JSON.parse, btoa: globalThis.btoa, map: Array.prototype.map, push: Array.prototype.push,
    charCodeAt: String.prototype.charCodeAt, Error: globalThis.Error, apply: Reflect.apply,
    length: Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length'),
  };
  JSON.stringify = () => { saw('JSON.stringify'); return '{}'; };
  globalThis.btoa = () => { saw('btoa'); return ''; };
  Array.prototype.map = function () { saw('Array.map'); return []; };
  Array.prototype.push = function () { saw('Array.push'); return 0; };
  String.prototype.charCodeAt = function () { saw('charCodeAt'); return 0; };
  Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'length', { get() { saw('length'); return 0; }, configurable: true });
  Object.defineProperty(Error.prototype, 'stack', { get() { saw('Error.stack'); return ''; }, configurable: true });
  Error.prepareStackTrace = () => { saw('prepareStackTrace'); return ''; };
  globalThis.Error = function () { saw('Error'); };
  Reflect.apply = () => { saw('Reflect.apply'); };
  aborts(() => sr.block('end', 'read'));
  Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'length', saved.length);
  JSON.stringify = saved.stringify; JSON.parse = saved.parse; globalThis.btoa = saved.btoa; Array.prototype.map = saved.map;
  Array.prototype.push = saved.push; String.prototype.charCodeAt = saved.charCodeAt; globalThis.Error = saved.Error; Reflect.apply = saved.apply;
  console.log(JSON.stringify({ calls, stopped }));
`);
assert.deepEqual(hostile.calls, [], 'the stop calls nothing the program replaced');
assert.equal(hostile.stopped.captured.stdout, 'printed "so far"\n', 'captured output rides the stop');
assert.equal(hostile.stopped.tape.reads[0], 2);
assert.equal(Buffer.from(hostile.stopped.tape.random, 'base64').length, 7);

const prefix = { stdout: b64('before ' + JSON.stringify(first.draws) + '\n'), stderr: b64('warn\n') };
const replay = { run: 2, tape: first.stopped.tape, stopAt: 1, prefix };
const replayed = (script, launch = replay) => guest(`
  const replay = JSON.parse(input);
  let boundaries = 0;
  sr.begin({ replay, abort, captured: false, nonce: NONCE, boundary: () => { boundaries++; } });
  sr.arm(false);
  const draws = () => [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), performance.now(), [...crypto.getRandomValues(new Uint8Array(4))]];
  ${script}
`, JSON.stringify(launch));

// Run 2 replays it: the same draws, the same output (dropped), the same read;
// at the boundary it tells the session, and goes on, live.
const second = replayed(`
  const d = draws();
  const dropped = [sr.write('stdout', enc('before ' + JSON.stringify(d) + '\\n')), sr.write('stderr', enc('warn\\n'))];
  const reads = [sr.readSome(7, false), sr.readSome(9, true)];
  const fresh = sr.write('stdout', enc('after\\n'));
  console.log(JSON.stringify({ d, dropped, reads, freshAt: fresh.at, freshRun: fresh.run, short: sr.finish(), boundaries }));
`);
assert.deepEqual(second.d, first.draws, 'every draw the stopped run made is drawn again');
assert.deepEqual(second.dropped, [null, null], 'what the stopped run printed is not sent again');
assert.deepEqual(second.reads, [3, 9], 'the stopped run\'s read returns what it did; past the boundary, what is there');
assert.deepEqual([second.freshAt, second.freshRun], [Buffer.from(prefix.stdout, 'base64').length, 2]);
assert.equal(second.short, '');
assert.equal(second.boundaries, 1, 'the session is told when the replay reaches the read');

// A replay is ended, before it shows or does anything, when it does not
// retrace the run before it.
const divergence = (script) => replayed(`aborts(() => { const d = draws(); ${script} }); console.log(JSON.stringify({ stopped }));`).stopped;
const writes = `sr.write('stdout', enc('before ' + JSON.stringify(d) + '\\n'));`;
assert.match(divergence(`${writes} sr.write('stdout', enc('C\\n'));`).why, /printed more to stdout than the run before/);
assert.match(divergence(`${writes} sr.readSome(3, false); sr.readSome(5, false);`).why, /had printed 5 bytes to stderr and this one 0/);
assert.match(divergence(`sr.effect('writeFile /x');`).why, /did something outside itself before the read/);
assert.match(divergence(`${writes} sr.write('stderr', enc('warn\\n')); sr.readSome(0, false); sr.block('data', 'read');`).why, /its read of stdin found less/);
const diverged = divergence(`sr.write('stdout', enc('BEFORE'));`);
assert.equal(diverged.kind, 'diverged');
assert.notEqual(stopRecordOf(new Error(STOP_RECORD_PREFIX + NONCE + ' ' + JSON.stringify(diverged)), NONCE, 2), null);

const unfinished = replayed(`console.log(JSON.stringify({ finish: sr.finish(), booted: sr.booted() }));`);
assert.match(unfinished.finish, /ended before the read of stdin it stopped at/);
assert.match(unfinished.booted, /finished starting before the read of stdin it stopped at/);

// A deterministic floating-read race: merely reissuing the read is not a
// delivery. fd 0 must expose none of its new bytes while its answer is held.
const floatingRace = guest(`
  sr.begin({ replay: { run: 2, tape: ${JSON.stringify(TAPE)}, stopAt: 0, prefix: null, observations: { stat: 1 } }, abort, nonce: NONCE });
  sr.arm(false);
  const supervisor = sr.ledger({ stat: () => new Promise(() => {}) });
  supervisor.stat('/floating-config');
  let consumed = false;
  aborts(() => { sr.readAll(4); consumed = true; });
  console.log(JSON.stringify({ consumed, stopped }));
`);
assert.equal(floatingRace.consumed, false);
assert.match(floatingRace.stopped.why, /before the recorded answer to stat was delivered/);

// A run that did something outside itself cannot stop; reads, a read-only
// open and its own output do not count, nor does anything before it started.
const ledgered = guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  const supervisor = sr.ledger({ stat: () => 'stat', fsOpen: () => 'open', writeFile: () => 'written', stdout: () => 'out', replayBoundary: () => 'b' });
  supervisor.writeFile('/during/boot', 'x');
  sr.arm(true);
  supervisor.stat('/a'); supervisor.fsOpen('/a', { read: true }); supervisor.stdout(enc('x')); supervisor.replayBoundary();
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
// D1: once it cannot be replayed, the run records nothing more.
const disqualified = guest(`
  sr.begin({ replay: null, abort, captured: false, nonce: NONCE });
  sr.arm(true);
  sr.effect('writeFile /x');
  for (let i = 0; i < 1000; i++) { Date.now(); Math.random(); }
  console.log(JSON.stringify({ why: sr.block('end', 'read') }));
`);
assert.match(disqualified.why, /writeFile \/x/);
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
// Captured output past the bound: no stop.
assert.match(guest(`
  sr.begin({ replay: null, abort, captured: true, capturedText: () => ({ stdout: 'x'.repeat(1024 * 1024 + 1), stderr: '' }), nonce: NONCE });
  sr.arm(true);
  console.log(JSON.stringify({ why: sr.block('end', 'read') }));
`).why, /printed more than 1048576 bytes first/);

console.log('stop-replay: the gate, the account, the journal, the record, the channel and the guest replay a stopped run, and refuse one that does not retrace it');
