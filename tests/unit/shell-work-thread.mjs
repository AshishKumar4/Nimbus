#!/usr/bin/env bun
// A shell's work, as the session counts it against its awaits
// (SessionProcessSupervisor: a process whose every unit of work is an await
// of a child it started is doing nothing but wait, and the Dynamic Worker
// ledger may refuse that child's wait when nothing can satisfy it). The
// shell here is the real one, its commands fakes the test steps through:
// `prog` runs a program (a child it awaits, as FacetManager.exec records),
// `step NAME` is work of the shell's own until the test lets it end, `stop`
// ends the program, as `kill` would.
//
// What has to hold:
//   - between two steps of a line the shell is never wait-only: after
//     `sleep` ends in `node x | (sleep 1; kill $(cat x.pid))`, the next step
//     (expanding `$(...)`, looking `kill` up, running it) is the shell's own
//     work, whichever turn it starts on. Before, the shell counted only its
//     commands: with `sleep` over and `kill` not yet begun, its one unit of
//     work was the await of `node x`, and the ledger could refuse a wait the
//     `kill` was about to free. The same with a background job beside a
//     line's steps.
//   - a shell that truly only awaits its program is still told as such, in
//     a sequence (`step a; prog`) or an and-or list (`prog && true`).
//   - every unit a line took is let go when it ends.

import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { memoryFiles } from './lib/test-box.mjs';

const { files: vfs, root } = memoryFiles();
root.mkdir('home/user', { recursive: true });
const processes = new SessionProcessSupervisor();
const shellPid = processes.spawn('sh', ['sh'], '/home/user').pid;

const gates = new Map();
const gate = (name) => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  gates.set(name, { promise, open });
  return promise;
};
const open = (name) => gates.get(name).open();

const registry = createDefaultRegistry();
let program = null;
registry.register('prog', async (ctx) => {
  const child = processes.spawn('node x', ['node', 'x'], '/home/user', { parentPid: ctx.pid });
  const endAwait = processes.beginAwait(ctx.pid, child.pid);
  program = child.pid;
  await gate('prog');
  processes.exit(child.pid, 137);
  endAwait();
  return 137;
});
registry.register('step', async (ctx) => { await gate(ctx.args[0]); return 0; });
let stopped = false;
registry.register('stop', async () => { stopped = true; open('prog'); return 0; });
// `kill` looked up on a later turn: the gap before it is more than microtasks.
const resolveCommand = registry.resolve.bind(registry);
registry.resolve = async (name, from) => {
  if (name === 'stop') await new Promise((resolve) => setTimeout(resolve, 0));
  return resolveCommand(name, from);
};

let cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const shell = new Shell(
  { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} },
  vfs,
  registry,
  { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' },
  new ProcessRegistry(),
  {
    pid: shellPid,
    get cred() { return cred; },
    setUmask: (mask) => { cred = { ...cred, umask: mask }; },
    accountWork: (pid) => processes.beginWork(pid),
  },
);

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
/** Every moment the session is told of a change, while `pending()` says a step is still to run, the shell must not be wait-only. */
const watch = (pending) => {
  const seen = [];
  processes.setOnWaitChange(() => {
    const on = processes.awaitsOnly(shellPid);
    if (on !== null && pending()) seen.push(on);
  });
  return seen;
};
/** No unit the line took is left: with one unit and one await begun now, the shell is wait-only. */
const assertNothingLeft = (what) => {
  const endWork = processes.beginWork(shellPid);
  const endAwait = processes.beginAwait(shellPid, 999_999);
  assert.deepEqual(processes.awaitsOnly(shellPid), [999_999], `${what}: every unit the line took was let go`);
  endAwait();
  endWork();
};

// ── a pipeline: the step after `sleep` is pending ──────────────────────────
{
  stopped = false;
  const seen = watch(() => !stopped);
  const done = shell.execute('prog | (step sleep; stop $(echo x))');
  await settle();
  assert.equal(processes.awaitsOnly(shellPid), null, 'while `sleep` runs, the shell has work of its own');
  open('sleep');
  const result = await done;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(stopped, 'the step after `sleep` ran');
  assert.deepEqual(seen, [], `between \`sleep\` and \`kill\`, the shell was never wait-only (seen wait-only on ${JSON.stringify(seen)})`);
  assertNothingLeft('the pipeline');
}

// ── a background job beside the line's steps ────────────────────────────────
{
  stopped = false;
  const seen = watch(() => !stopped);
  const done = shell.execute('prog & step a; stop $(echo x)');
  await settle();
  assert.equal(processes.awaitsOnly(shellPid), null, 'while `step a` runs, the shell has work of its own');
  open('a');
  const result = await done;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(stopped);
  assert.deepEqual(seen, [], `between \`step a\` and \`stop\`, the shell was never wait-only (seen ${JSON.stringify(seen)})`);
  await settle();
  assertNothingLeft('the background job');
}

// ── a shell that only awaits its program is told as such ───────────────────
// (`prog` ends killed, 137: `&&` skips what follows it.)
for (const [line, status] of [['step a; prog', 137], ['prog && true', 137], ['prog | (true) && true', 0]]) {
  processes.setOnWaitChange(null);
  const done = shell.execute(line);
  await settle();
  if (line.startsWith('step')) {
    assert.equal(processes.awaitsOnly(shellPid), null, `${line}: \`step a\` is the shell's work`);
    open('a');
    await settle();
  }
  assert.deepEqual(processes.awaitsOnly(shellPid), [program], `${line}: awaiting its program is all the shell does`);
  open('prog');
  const result = await done;
  assert.equal(result.exitCode, status, `${line}: ${result.stderr}`);
  assertNothingLeft(line);
}

console.log('ok - shell-work-thread (never wait-only between two steps of a line; wait-only when only awaiting its program; nothing left after)');
process.exit(0);
