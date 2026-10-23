#!/usr/bin/env bun
// A process whose program takes its own signals (SessionProcessSupervisor
// .takeSignals, a WASI image that raises what its host sends it), and the
// command that runs it (openInvocationStdio):
//
//   - a kill of it with a signal it catches, or a client's signal frame, is
//     queued for its program (nextSignal) and does not end it; SIGKILL, and
//     a signal it does not catch, still end it;
//   - one wait for the next signal at a time: a later one answers the
//     earlier null; the process's end answers it null;
//   - its stdin read is interrupted by a signal and takes nothing: input that
//     came with it is the next read's;
//   - the terminal's key (the command's abort with a signal) is sent to it
//     and to every process below it, as to a foreground job's process group:
//     each takes it as a kill gives it, its program's own where it takes
//     its signals, its end where not; the run is not ended by it;
//   - its command's status is its program's (CommandContext.takesSignals);
//   - a run on an adopted process takes its signals for that run alone;
//   - a parent's kill of it (the child broker's) is delivered, not its end,
//     and a child its group's signal ended is reported killed by it;
//   - its write to a full pipe waits until a signal, which withdraws it at
//     once; a signal that comes as the write is made is the next wait's;
//   - a wait for the next signal of a process that takes none lasts as long
//     as one that waits for its first, so a guest asking again does not spin;
//   - the terminal's keys after the first go to the shell's foreground job
//     (signalForeground): each process below the shell marked foreground,
//     with its group, and never a background job;
//   - a signal that waits in the box, never handed to the program, is
//     untaken (untakenSignal).

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ChildProcessManager } from '../../packages/core/src/runtime/child-process-manager.ts';
import { openInvocationStdio, openRuntimeStdio } from '../../packages/core/src/runtime/runtime-stdio.ts';
import { signalAbortReason } from '../../packages/core/src/substrate/lifo/shell/signals.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';

const CATCHES = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'];
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
/** How many bytes `pid`'s input holds, read to the last. */
const drainAll = async (processes, pid) => {
  let bytes = 0;
  for (let packet = await processes.readInput(pid, 50); packet.data.length > 0; packet = await processes.readInput(pid, 50)) bytes += packet.data.length;
  return bytes;
};
/** `promise`'s value, or 'still waiting' once `ms` pass. */
const within = (ms, promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms))]);

// ── a kill it catches is its program's; one it does not ends it ──────────
{
  const processes = new SessionProcessSupervisor();
  const git = processes.spawn('git', ['git'], '/home/user');
  processes.takeSignals(git.pid, CATCHES);
  let stopped = 0;
  processes.setTerminator(git.pid, () => { stopped++; });

  assert.equal(processes.kill(git.pid, 130, signalAbortReason('INT')), true, 'a kill with SIGINT is delivered');
  assert.equal(processes.get(git.pid).state, 'running', 'and does not end it');
  assert.equal(stopped, 0, 'nor stop its work');
  assert.equal(await processes.nextSignal(git.pid, 100), 'SIGINT', 'its program takes it');
  assert.deepEqual(processes.signal(git.pid, 'SIGTERM'), { ok: true }, 'a client\'s frame too');
  assert.equal(await processes.nextSignal(git.pid, 100), 'SIGTERM');
  assert.equal(await processes.nextSignal(git.pid, 20), null, 'none more');

  processes.kill(git.pid, 138, signalAbortReason('USR1'));
  assert.equal(processes.get(git.pid).state, 'killed', 'a signal it does not catch ends it');
  assert.equal(stopped, 1);

  const other = processes.spawn('git', ['git'], '/home/user');
  processes.takeSignals(other.pid, CATCHES);
  processes.kill(other.pid, 137, signalAbortReason('KILL'));
  assert.equal(processes.get(other.pid).state, 'killed', 'SIGKILL ends it');
}

// ── one wait at a time; its end answers it ───────────────────────────────
{
  const processes = new SessionProcessSupervisor();
  const git = processes.spawn('git', ['git'], '/home/user');
  processes.takeSignals(git.pid, CATCHES);
  const first = processes.nextSignal(git.pid, 5_000);
  const second = processes.nextSignal(git.pid, 5_000);
  assert.equal(await first, null, 'a later wait answers the earlier one');
  processes.signal(git.pid, 'SIGINT');
  assert.equal(await second, 'SIGINT', 'and takes the next signal');
  const waiting = processes.nextSignal(git.pid, 5_000);
  processes.exit(git.pid, 0);
  assert.equal(await waiting, null, 'its end answers a wait');
  assert.deepEqual(processes.signal(git.pid, 'SIGINT').ok, false, 'and nothing is delivered after it');
}

// ── a stdin read a signal interrupts takes nothing ───────────────────────
{
  const processes = new SessionProcessSupervisor();
  const git = processes.spawn('git', ['git'], '/home/user');
  processes.openInput(git.pid);
  processes.takeSignals(git.pid, CATCHES);
  const reading = processes.readInput(git.pid, 5_000);
  await settle();
  processes.signal(git.pid, 'SIGINT');
  assert.deepEqual(await reading, { data: '', ended: false, signal: 'SIGINT' }, 'the read answers the signal');
  processes.writeInput(git.pid, 'typed');
  assert.equal((await processes.readInput(git.pid, 100)).data, 'typed', 'and input after it is the next read\'s');
  // A signal sent while it was not reading is the next read's answer.
  processes.signal(git.pid, 'SIGTERM');
  assert.equal((await processes.readInput(git.pid, 100)).signal, 'SIGTERM');
  processes.writeInput(git.pid, 'more');
  assert.equal((await processes.readInput(git.pid, 100)).data, 'more');
}

// ── the terminal's key goes to it and the processes below it ─────────────
{
  const processes = new SessionProcessSupervisor();
  const shell = processes.spawn('sh', ['sh'], '/home/user');
  const line = new AbortController();
  let tookSignals = false;
  const ctx = {
    pid: shell.pid, cred: CRED_SESSION_USER, cwd: '/home/user', signal: line.signal,
    stdout: { write() {} }, stderr: { write() {} }, takesSignals: () => { tookSignals = true; },
  };
  const stdio = openRuntimeStdio({ filesystem: { bind: () => ({}) }, processes }, ctx, 'git commit -a', { takesSignals: true });
  assert.equal(tookSignals, true, 'the command says its status is its program\'s');
  const editor = processes.spawn('sh -c sleep 60', ['sh'], '/home/user', { parentPid: stdio.pid });
  const sleeper = processes.spawn('sleep 60', ['sleep'], '/home/user', { parentPid: editor.pid });
  const bystander = processes.spawn('vite', ['vite'], '/home/user', { parentPid: shell.pid });
  line.abort(signalAbortReason('INT'));
  assert.equal(stdio.signal.aborted, false, 'the run goes on');
  assert.equal(processes.get(stdio.pid).state, 'running');
  assert.equal(await processes.nextSignal(stdio.pid, 100), 'SIGINT', 'its program is sent SIGINT');
  assert.deepEqual([processes.get(editor.pid).state, processes.get(editor.pid).exitCode], ['killed', 130], 'the processes below it end of it');
  assert.equal(processes.get(sleeper.pid).state, 'killed');
  assert.equal(processes.get(bystander.pid).state, 'running', 'one beside it does not');
  await stdio.finish(1);
}

// ── a run whose program does not take its signals is ended by the abort ──
{
  const processes = new SessionProcessSupervisor();
  const shell = processes.spawn('sh', ['sh'], '/home/user');
  const line = new AbortController();
  const stdio = openInvocationStdio(processes, {
    existingPid: undefined, command: 'git', argv: ['git'], cwd: '/home/user', parentPid: shell.pid,
    cred: CRED_SESSION_USER, signal: line.signal, input: null, output: null,
  });
  line.abort(signalAbortReason('INT'));
  assert.equal(stdio.signal.aborted, true, 'its run is ended');
  assert.equal(await processes.nextSignal(stdio.pid, 20), null, 'nothing is queued for it');
  stdio.release();
}

// ── a run on an adopted process takes its signals for that run alone ────
{
  const processes = new SessionProcessSupervisor();
  const wrapper = processes.spawn('sh', ['sh'], '/home/user');
  const run = openInvocationStdio(processes, {
    existingPid: wrapper.pid, command: 'git', argv: ['git'], cwd: '/home/user', parentPid: undefined,
    cred: CRED_SESSION_USER, signal: undefined, takesSignals: true, input: null, output: null,
  });
  processes.kill(wrapper.pid, 130, signalAbortReason('INT'));
  assert.equal(processes.get(wrapper.pid).state, 'running', 'while git runs on it, a SIGINT is git\'s');
  assert.equal(await processes.nextSignal(wrapper.pid, 100), 'SIGINT');
  run.release();
  processes.kill(wrapper.pid, 130, signalAbortReason('INT'));
  assert.deepEqual([processes.get(wrapper.pid).state, processes.get(wrapper.pid).exitCode], ['killed', 130], 'once it ended, the next program the process runs is ended by one');
}

// ── a parent's kill(2) of a child that takes its signals is delivered ────
{
  const processes = new SessionProcessSupervisor();
  const parent = processes.spawn('bash', ['bash'], '/home/user');
  const manager = new ChildProcessManager({
    processes,
    terminate(pid) { return processes.kill(pid, 143); },
    async resolve() { return { run: () => new Promise(() => {}) }; },
  });
  const { childPid } = await manager.spawn({ parentPid: parent.pid, command: 'git', args: [], cwd: '/home/user', env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.takeSignals(childPid, CATCHES);
  assert.equal(manager.kill(childPid, 'SIGINT'), true, 'the kill is delivered');
  assert.equal(processes.get(childPid).state, 'running', 'the child runs on');
  assert.equal((await manager.wait(childPid, 50)).done, false, 'and its parent sees no exit');
  assert.equal(await processes.nextSignal(childPid, 100), 'SIGINT', 'its program takes it');
  assert.equal(manager.kill(childPid, 'SIGUSR1'), true);
  assert.deepEqual([(await manager.wait(childPid, 1000)).signal], ['SIGUSR1'], 'one it does not catch ends it');
}

// ── a child its process group's signal ended died of that signal ─────────
// Its parent (git, waiting for its editor) sees it killed by SIGINT, as
// Linux reports it, whatever the child's run returned as it was stopped.
{
  const processes = new SessionProcessSupervisor();
  const parent = processes.spawn('git', ['git'], '/home/user');
  const manager = new ChildProcessManager({
    processes,
    terminate(pid) { return processes.kill(pid, 143); },
    async resolve() { return { run: (context) => new Promise((resolve) => { context.onStarted(); processes.subscribeTerminal(context.pid, () => resolve(1)); }) }; },
  });
  processes.takeSignals(parent.pid, CATCHES);
  const { childPid } = await manager.spawn({ parentPid: parent.pid, command: 'sh', args: ['-c', 'sleep 60'], cwd: '/home/user', env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  await manager.wait(childPid, 100, false);
  processes.signalGroup(parent.pid, signalAbortReason('INT'));
  assert.equal(await processes.nextSignal(parent.pid, 100), 'SIGINT', 'git is sent it');
  const exit = await manager.wait(childPid, 1000);
  assert.deepEqual([exit.done, exit.exitCode, exit.signal], [true, null, 'SIGINT'], 'its parent sees it killed by SIGINT');
}

// ── its write to a full pipe is interrupted, and withdrawn ───────────────
{
  const processes = new SessionProcessSupervisor();
  const git = processes.spawn('git', ['git'], '/home/user');
  const helper = processes.spawn('cat', ['cat'], '/home/user', { parentPid: git.pid });
  processes.openInput(helper.pid);
  processes.takeSignals(git.pid, CATCHES);
  processes.signal(git.pid, 'SIGTERM');
  const fill = new Uint8Array(256 * 1024).fill(1);
  assert.deepEqual(await processes.writeInputBytesWait(helper.pid, fill, git.pid), { ok: true }, 'a write there is room for is made, a signal pending or not');
  assert.equal(await processes.nextSignal(git.pid, 100), 'SIGTERM', 'and leaves the signal for its next wait');
  const held = processes.writeInputBytesWait(helper.pid, new Uint8Array([2, 2, 2]), git.pid);
  await settle();
  processes.signal(git.pid, 'SIGINT');
  assert.deepEqual(await within(1000, held), { ok: false, signal: 'SIGINT' }, 'one waiting for room answers a signal');
  assert.equal(await drainAll(processes, helper.pid), 256 * 1024, 'and wrote nothing');
}

// ── a signal that comes as its write is made is not lost ───────────────
// The reader makes room and the signal comes, a number of microtasks apart:
// the write is made and the signal is its next wait's, or it is withdrawn and
// answers the signal; never made with the signal gone.
for (let ticks = 0; ticks < 16; ticks++) {
  const processes = new SessionProcessSupervisor();
  const git = processes.spawn('git', ['git'], '/home/user');
  const helper = processes.spawn('cat', ['cat'], '/home/user', { parentPid: git.pid });
  processes.openInput(helper.pid);
  processes.takeSignals(git.pid, CATCHES);
  await processes.writeInputBytesWait(helper.pid, new Uint8Array(256 * 1024), git.pid);
  const held = processes.writeInputBytesWait(helper.pid, new Uint8Array([2]), git.pid);
  await settle();
  const drain = processes.readInput(helper.pid, 100);
  for (let i = 0; i < ticks; i++) await Promise.resolve();
  processes.signal(git.pid, 'SIGINT');
  const answer = await within(1000, held);
  const written = (await drain).data.length + await drainAll(processes, helper.pid) - 256 * 1024;
  if (answer.ok === true) {
    assert.equal(written, 1, `${ticks}: the write was made`);
    assert.equal(await processes.nextSignal(git.pid, 50), 'SIGINT', `${ticks}: and the signal that came with it is the next wait's`);
  } else {
    assert.deepEqual([answer, written], [{ ok: false, signal: 'SIGINT' }, 0], `${ticks}: or it answered the signal and wrote nothing`);
  }
}

// A process that takes none: its wait for a signal lasts, as an empty box's does.
{
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('python3', ['python3'], '/home/user');
  const started = Date.now();
  assert.equal(await processes.nextSignal(pid, 300), null, 'none comes');
  assert.ok(Date.now() - started >= 290, `and the wait lasted its bound: ${Date.now() - started} ms`);
}

// The terminal's keys after the first: the shell's foreground job, not its background ones.
{
  const processes = new SessionProcessSupervisor();
  const shell = processes.spawn('sh', ['sh'], '/home/user');
  const job = processes.spawn('python3', ['python3', 'a.py'], '/home/user', { parentPid: shell.pid });
  const child = processes.spawn('cat', ['cat'], '/home/user', { parentPid: job.pid });
  const background = processes.spawn('python3', ['python3', 'b.py'], '/home/user', { parentPid: shell.pid });
  processes.takeSignals(job.pid, CATCHES);
  processes.takeSignals(background.pid, CATCHES);
  processes.setForeground(job.pid, true);
  processes.signalForeground(shell.pid, signalAbortReason('INT'));
  assert.equal(processes.untakenSignal(job.pid), 'SIGINT', 'the foreground job\'s program is sent it, and it waits there untaken');
  assert.equal(await processes.nextSignal(job.pid, 100), 'SIGINT', 'until its program takes it');
  assert.equal(processes.untakenSignal(job.pid), null);
  assert.equal(processes.get(child.pid).state, 'killed', 'a process below it that takes none is ended by it');
  assert.equal(processes.get(shell.pid).state, 'running', 'the shell is not');
  assert.equal(processes.untakenSignal(background.pid), null, 'a background job is sent nothing');
  assert.equal(processes.get(background.pid).state, 'running');
}

console.log('process-takes-signals: ok');
