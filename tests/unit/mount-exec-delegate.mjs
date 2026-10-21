#!/usr/bin/env bun
// A mount's exec delegate (Kinu ask 66): a program started with its cwd
// under the mount runs on the machine its files live on. Each program start
// is one call, by its argv, as execvp starts it; the shell keeps everything
// it does itself (builtins, functions, pipes, expansions). Before, every
// program ran in the session whatever its cwd: `cd /m && tool` found no
// tool, or ran the session's own.
// The delegate here is a fake process table: `tool` prints three lines,
// `cat` copies its input, `sleep` runs until signalled, `hold` starts only
// when its start is cancelled (to stop it pending), `offline` is refused
// EHOSTDOWN, anything else ENOENT.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { signalAbortReason } from '../../packages/core/src/substrate/lifo/shell/signals.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const starts = [];
const kills = [];
const encoder = new TextEncoder();
const refusal = (code, message) => Object.assign(new Error(message), { code });

/** A started program whose body `run(write)` returns its exit; `kill` ends a waiting one with the signal. */
function program(run) {
  let write;
  let finish;
  const exit = new Promise((resolve) => { finish = resolve; });
  const output = new ReadableStream({ start(controller) { write = controller; } });
  let killed = null;
  const started = {
    output,
    exit,
    kill(signal) { kills.push(signal); killed?.(signal); },
  };
  Promise.resolve().then(async () => {
    const status = await run({
      out: (text) => write.enqueue({ stream: 'stdout', data: typeof text === 'string' ? encoder.encode(text) : text }),
      untilKilled: () => new Promise((resolve) => { killed = resolve; }),
    });
    write.close();
    finish(status);
  });
  return started;
}

const delegate = {
  async start(spec, cancel) {
    starts.push({ argv: [...spec.argv], cwd: spec.cwd, FOO: spec.env.FOO ?? null, stdin: spec.stdin === null ? 'closed' : 'stream' });
    const [name] = spec.argv;
    if (name === 'hold') {
      await new Promise((resolve) => cancel.addEventListener('abort', resolve, { once: true }));
      throw refusal('ECANCELED', 'operation canceled');
    }
    if (name === 'offline') throw refusal('EHOSTDOWN', 'the computer is offline');
    if (name === 'tool') return program(async ({ out }) => { out('one\ntwo\nthree\n'); return { code: 0, signal: null }; });
    if (name === 'cat') {
      return program(async ({ out }) => {
        if (spec.stdin !== null) for await (const chunk of spec.stdin) out(chunk);
        return { code: 0, signal: null };
      });
    }
    if (name === 'sleep') return program(async ({ untilKilled }) => ({ code: null, signal: await untilKilled() }));
    throw refusal('ENOENT', `${name}: not found`);
  },
  async locate(name) {
    return ['tool', 'cat', 'sleep'].includes(name) ? `/usr/bin/${name}` : null;
  },
};

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
const files = new MemoryVFS({ uid: 1000, gid: 1000 });
files.mkdir('/x/item', { recursive: true });
ws.filesystem.vfs.mount('/m', files, { exec: delegate });
let present = true;
const flaky = new MemoryVFS({ uid: 1000, gid: 1000 });
ws.filesystem.vfs.mount('/flaky', () => (present ? flaky : null), { exec: delegate, absentReason: () => 'the computer is offline' });

const run = async (line, options = {}) => {
  starts.length = 0;
  kills.length = 0;
  const result = await ws.exec(line, options);
  return { out: result.stdout, err: result.stderr, code: result.exitCode, starts: starts.map((s) => ({ ...s })), kills: [...kills] };
};

try {
  let r = await run('cd /m && tool --flag');
  assert.equal(r.out, 'one\ntwo\nthree\n');
  assert.equal(r.code, 0);
  assert.deepEqual(r.starts.map((s) => [s.argv, s.cwd]), [[['tool', '--flag'], '/']], 'one start, its argv, the mount\'s cwd');

  r = await run('cd /m && echo hi && printf x && command printf y && type -t cd >/dev/null');
  assert.equal(r.out, 'hi\nxy');
  assert.deepEqual(r.starts, [], 'the shell\'s own commands start nothing');

  r = await run('cd /m && f() { echo fn; }; f');
  assert.equal(r.out, 'fn\n');
  assert.deepEqual(r.starts, [], 'a function starts nothing');

  r = await run('(cd /m && exec printf x); echo "s=$?"');
  assert.deepEqual(r.starts.map((s) => s.argv), [['printf', 'x']], 'exec starts the program, never the builtin');
  assert.equal(r.out, 's=127\n');
  assert.match(r.err, /printf: command not found/);

  r = await run('cd /m && FOO=1 tool | FOO=2 cat; echo "${PIPESTATUS[*]}"');
  assert.equal(r.out, 'one\ntwo\nthree\n0 0\n');
  assert.deepEqual(r.starts.map((s) => [s.argv[0], s.FOO]), [['tool', '1'], ['cat', '2']], 'each start, its own environment');

  r = await run('cd /m && echo x | cat');
  assert.equal(r.out, 'x\n');
  assert.deepEqual(r.starts.map((s) => [s.argv, s.stdin]), [[['cat'], 'stream']], 'the local echo\'s output is the start\'s input');

  r = await run('cd /m/x && tool >/dev/null; cd /home/user && tool; echo "local=$?"');
  assert.deepEqual(r.starts.map((s) => [s.argv, s.cwd]), [[['tool'], '/x']], 'placed by its own cwd: the mount\'s, then the session\'s');
  assert.equal(r.out, 'local=127\n');

  r = await run('cd / && find /m/x/item -maxdepth 0 -execdir tool \\;');
  assert.deepEqual(r.starts.map((s) => [s.argv, s.cwd]), [[['tool'], '/x']], 'execvp from a local find: the item\'s directory');
  assert.equal(r.out, 'one\ntwo\nthree\n');

  r = await run('cd /m && missing; echo "s=$?"');
  assert.equal(r.out, 's=127\n');
  assert.match(r.err, /^missing: command not found$/m);

  r = await run('cd /m && offline; echo "s=$?"');
  assert.equal(r.out, 's=126\n');
  assert.match(r.err, /^offline: the computer is offline$/m);

  r = await run('cd /m && env tool >/dev/null; env offline; echo "s=$?"');
  assert.deepEqual(r.starts.map((s) => s.argv), [['tool'], ['offline']]);
  assert.equal(r.out, 's=126\n');
  assert.match(r.err, /env: 'offline': the computer is offline/);

  // A mount gone absent under the cwd: the start is refused with its reason, and the delegate not asked.
  await ws.exec('cd /flaky', { shellId: 'flaky' });
  present = false;
  r = await run('tool; echo "s=$?"', { shellId: 'flaky' });
  present = true;
  assert.deepEqual(r.starts, []);
  assert.equal(r.out, 's=126\n');
  assert.match(r.err, /^tool: the computer is offline$/m);

  // Ctrl-C reaches a running program as SIGINT; its status is 130.
  const stop = new AbortController();
  const sleeping = run('cd /m && sleep 600', { signal: stop.signal });
  for (let i = 0; i < 100 && starts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort(signalAbortReason('INT'));
  r = await sleeping;
  assert.deepEqual(r.kills, ['SIGINT']);
  assert.equal(r.code, 130);

  // Ctrl-C while a start is pending cancels it: nothing runs, and the status is the stop's.
  const held = new AbortController();
  const holding = run('cd /m && hold', { signal: held.signal });
  for (let i = 0; i < 100 && starts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  held.abort(signalAbortReason('INT'));
  r = await holding;
  assert.deepEqual(r.kills, []);
  assert.equal(r.code, 130);
  assert.equal(r.err, '');
} finally {
  await ws.close();
}
console.log('mount-exec-delegate: programs under a delegating mount start on its machine, one start each');
