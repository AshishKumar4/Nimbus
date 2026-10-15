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
//   - its command's status is its program's (CommandContext.takesSignals).

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { openInvocationStdio, openRuntimeStdio } from '../../packages/core/src/runtime/runtime-stdio.ts';
import { signalAbortReason } from '../../packages/core/src/substrate/lifo/shell/signals.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';

const CATCHES = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'];
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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

console.log('process-takes-signals: ok');
