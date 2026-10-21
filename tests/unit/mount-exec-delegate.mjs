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
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
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
  // A signal sent before the program waits for one is kept for it.
  let killed = null;
  let sent = null;
  const started = {
    output: null,
    exit,
    kill(signal) { kills.push(signal); if (killed) killed(signal); else sent = signal; },
  };
  // A reader that has cancelled its output takes no more of it, as a machine's stream would drop it.
  let open = true;
  const output = new ReadableStream({ start(controller) { write = controller; }, cancel() { open = false; } });
  started.output = output;
  Promise.resolve().then(async () => {
    const status = await run({
      out: (text) => { if (open) write.enqueue({ stream: 'stdout', data: typeof text === 'string' ? encoder.encode(text) : text }); },
      untilKilled: () => new Promise((resolve) => { if (sent !== null) resolve(sent); else killed = resolve; }),
    });
    if (open) write.close();
    finish(status);
  });
  return started;
}

const delegate = {
  async start(spec, cancel) {
    starts.push({ argv: [...spec.argv], cwd: spec.cwd, FOO: spec.env.FOO ?? null, stdin: spec.stdin === null ? 'closed' : 'stream' });
    const name = spec.argv[0].replace(/^\/usr\/bin\//, '');
    if (name === 'race') {
      // Stopped while pending, it starts anyway: the contract's other settlement, killed at once.
      await new Promise((resolve) => cancel.addEventListener('abort', resolve, { once: true }));
      return program(async ({ untilKilled }) => ({ code: null, signal: await untilKilled() }));
    }
    if (name === 'yes') {
      return program(async ({ out, untilKilled }) => {
        let ended = null;
        untilKilled().then((signal) => { ended = signal; });
        while (ended === null) { out('y\n'); await new Promise((resolve) => setTimeout(resolve, 1)); }
        return { code: null, signal: ended };
      });
    }
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
// A mount whose lookups fail: what starts under it is refused, never run here instead.
const failing = () => { throw syscallError('EIO', 'stat', '/x'); };
ws.filesystem.vfs.mount('/sick', { stat: failing, readFile: failing, writeFile: failing, readdir: failing, mkdir: failing, unlink: failing }, { exec: delegate });

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

  // env is a program, the machine's: it is started, with what it runs as its arguments.
  r = await run('cd /m && env FOO=3 tool; echo "s=$?"');
  assert.deepEqual(r.starts.map((s) => s.argv), [['env', 'FOO=3', 'tool']]);
  assert.equal(r.out, 's=127\n');

  // A local find's -execdir under the mount: a refused start is find's to report, in the machine's words.
  r = await run('cd / && find /m/x/item -maxdepth 0 -execdir offline \\; ; echo "s=$?"');
  assert.deepEqual(r.starts.map((s) => [s.argv, s.cwd]), [[['offline'], '/x']]);
  assert.match(r.err, /find: 'offline': the computer is offline/);

  // A mount gone absent under the cwd: the start is refused with its reason, and the delegate not asked.
  await ws.exec('cd /flaky', { shellId: 'flaky' });
  present = false;
  r = await run('tool; echo "s=$?"', { shellId: 'flaky' });
  present = true;
  assert.deepEqual(r.starts, []);
  assert.equal(r.out, 's=126\n');
  assert.match(r.err, /^tool: the computer is offline$/m);

  // type and command -v report what a start from the cwd would run: the machine's program, or none.
  r = await run('cd /m && type tool cd; type missing; command -v tool; command -V cat');
  assert.equal(r.out, 'tool is /usr/bin/tool\ncd is a shell builtin\n/usr/bin/tool\ncat is /usr/bin/cat\n');
  assert.match(r.err, /^type: missing: not found$/m);
  assert.deepEqual(r.starts, []);

  // hash finds the machine's program and remembers nothing of it.
  r = await run('cd /m && hash tool; hash missing; echo "s=$?"; hash -l');
  assert.equal(r.out.split('\n')[0], 's=1');
  assert.ok(!r.out.includes('tool'), r.out);
  assert.match(r.err, /^hash: missing: not found$/m);
  assert.deepEqual(r.starts, []);

  // A write that fails (not a closed pipe) ends the program before the shell goes on.
  r = await run('cd /m && yes > /dev/full; echo "s=$?"');
  assert.deepEqual(r.kills, ['SIGKILL']);
  assert.equal(r.out, 's=1\n');

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

  // Or settled by starting it and sending SIGKILL: the status is still the stop's.
  const raced = new AbortController();
  const racing = run('cd /m && race', { signal: raced.signal });
  for (let i = 0; i < 100 && starts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  raced.abort(signalAbortReason('INT'));
  r = await racing;
  assert.deepEqual(r.kills, ['SIGKILL']);
  assert.equal(r.code, 130);
  // Node's child_process, through the workspace's child broker as a node program's spawn reaches it.
  const child = async (request, input) => {
    starts.length = 0;
    kills.length = 0;
    const parent = ws.processes.spawn('node', ['node'], '/home/user', { parentPid: ws.shellProcessPid });
    const { childPid } = await ws.children.spawn({ args: [], env: { PATH: '/usr/bin' }, stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid, ...request });
    if (input !== undefined) {
      for (const bytes of input) await ws.children.stdinWrite(childPid, bytes);
      await ws.children.stdinEnd(childPid);
    }
    let exit = await ws.children.wait(childPid);
    while (!exit.done) exit = await ws.children.wait(childPid);
    const drained = await ws.children.drainOutput(childPid);
    ws.processes.exit(parent.pid, 0);
    return { exit, bytes: [...drained.stdout], out: new TextDecoder().decode(drained.stdout), starts: starts.map((x) => ({ ...x })) };
  };
  let c = await child({ command: 'tool', cwd: '/m/x' });
  assert.deepEqual(c.starts.map((x) => [x.argv, x.cwd, x.stdin]), [[['tool'], '/x', 'stream']], 'execFile: one start, a stdin it may leave unread');
  assert.deepEqual([c.exit.exitCode, c.exit.signal, c.out], [0, null, 'one\ntwo\nthree\n']);
  c = await child({ command: 'sh', args: ['-c', 'echo'], cwd: '/m' });
  assert.deepEqual(c.starts.map((x) => x.argv), [['sh', '-c', 'echo']], 'sh -c is the machine\'s, not a local shell');
  c = await child({ command: 'ls -l', cwd: '/m', shell: true });
  assert.deepEqual(c.starts.map((x) => x.argv), [['/bin/sh', '-c', 'ls -l']], 'shell: Node\'s own argv');
  c = await child({ command: 'cat', cwd: '/m' }, [new Uint8Array([0, 0xff, 0x80]), new TextEncoder().encode('tail')]);
  assert.deepEqual(c.bytes, [0, 0xff, 0x80, ...new TextEncoder().encode('tail')], 'spawn: its input, byte for byte, written after the start');
  c = await child({ command: 'missing', cwd: '/m' });
  assert.deepEqual([c.exit.spawnError, c.exit.exitCode], ['ENOENT', -2], 'a refused start is the error event, ENOENT');
  c = await child({ command: 'offline', cwd: '/m' });
  assert.equal(c.exit.spawnError, 'EHOSTDOWN');
  // Node's file as the program named it.
  c = await child({ command: '/usr/bin/tool', cwd: '/m' });
  assert.deepEqual(c.starts.map((x) => x.argv), [['/usr/bin/tool']]);
  assert.equal(c.out, 'one\ntwo\nthree\n');

  // child.kill('SIGINT') is the program's SIGINT; it ends with that signal.
  {
    starts.length = 0;
    kills.length = 0;
    const parent = ws.processes.spawn('node', ['node'], '/home/user', { parentPid: ws.shellProcessPid });
    const { childPid } = await ws.children.spawn({ command: 'sleep', args: ['600'], env: {}, cwd: '/m', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid });
    for (let i = 0; i < 100 && starts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ws.children.kill(childPid, 'SIGINT'), true);
    let exit = await ws.children.wait(childPid);
    while (!exit.done) exit = await ws.children.wait(childPid);
    assert.deepEqual(kills, ['SIGINT']);
    assert.deepEqual([exit.exitCode, exit.signal], [null, 'SIGINT'], 'as Node reports a signal: no code');
    ws.processes.exit(parent.pid, 0);
  }

  // A cwd under a delegating mount whose lookup fails: refused, the delegate not asked, nothing run here.
  c = await child({ command: 'tool', cwd: '/sick/x' });
  assert.equal(c.exit.spawnError, 'EHOSTDOWN');
  assert.deepEqual(c.starts, []);

  // A local cwd: found here, where there is no tool, and the delegate not asked.
  starts.length = 0;
  await assert.rejects(child({ command: 'tool', cwd: '/home/user' }), { code: 'ENOENT' });
  assert.deepEqual(starts, []);
} finally {
  await ws.close();
}
console.log('mount-exec-delegate: programs under a delegating mount start on its machine, one start each');
