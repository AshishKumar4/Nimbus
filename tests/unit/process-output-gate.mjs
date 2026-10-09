#!/usr/bin/env bun
// A process's output reaches no observer while the session's output gate
// holds it (SessionProcessSupervisor.setOutputGate): not its log or live
// sinks, not its terminal tee, not a parent reading it through a pipe, not
// the shell's own terminal frames, and not its exit, which comes after the
// output before it. Another process's output is not held behind it, and
// with nothing held every observer hears at once, as before.

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { WebSocketTerminal } from '../../packages/worker/src/facets/ws-terminal.ts';
import { _emitShellExecDone, _rpcReportExit, _rpcStdout } from '../../packages/worker/src/session/rpc.ts';

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A gate holding the pids in `held` until each is let go. */
function holdingGate() {
  const held = new Map();
  return {
    gate: { before: (pid) => held.get(pid)?.promise ?? null },
    hold(pid) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      held.set(pid, { promise, resolve });
    },
    release(pid) { held.get(pid).resolve(); held.delete(pid); },
  };
}

// Nothing held: every observer hears at once, synchronously, as before.
{
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('a', [], '/');
  const seen = [];
  processes.subscribeOutputBytes(pid, (c) => { seen.push(text(c.data)); });
  processes.setOutputGate({ before: () => null });
  void processes.appendOutputBytes(pid, 'stdout', bytes('x'));
  processes.markExit(pid, 0);
  assert.deepEqual(seen, ['x'], 'ungated output is delivered in the call');
  assert.equal(processes.getExit(pid)?.code, 0, 'ungated exit is recorded in the call');
}

// Held: the log, the live sink and the exit wait, in order; another pid does not.
{
  const processes = new SessionProcessSupervisor();
  const a = processes.spawn('a', [], '/').pid;
  const b = processes.spawn('b', [], '/').pid;
  const gate = holdingGate();
  processes.setOutputGate(gate.gate);
  const seen = [];
  for (const pid of [a, b]) {
    processes.subscribeOutputBytes(pid, (c) => { seen.push(`${pid}:${text(c.data)}`); });
    processes.subscribeExit(pid, (exit) => { seen.push(`${pid}:exit ${exit.code}`); });
  }
  gate.hold(a);
  const first = processes.appendOutputBytes(a, 'stdout', bytes('one'));
  processes.appendOutput(a, 'stderr', 'two');
  processes.markExit(a, 3);
  await processes.appendOutputBytes(b, 'stdout', bytes('other'));
  processes.markExit(b, 0);
  await turns();
  assert.deepEqual(seen, [`${b}:other`, `${b}:exit 0`], 'a held process holds only its own output');
  assert.equal(processes.getExit(a), null);
  assert.equal(processes.logSize(a), 0);
  gate.release(a);
  await first;
  await turns();
  assert.deepEqual(seen.slice(2), [`${a}:one`, `${a}:two`, `${a}:exit 3`], 'released in the order the process made it, its exit last');
}

// The terminal tee and the exit report of a facet process.
{
  const processes = new SessionProcessSupervisor();
  const writes = [];
  const notices = [];
  const host = {
    processes,
    terminal: { write: (data) => writes.push(data) },
    shell: {
      queueProcessExitNotice(notice) { notices.push(notice); return true; },
      writeNotice(data) { writes.push(data); },
    },
    _emitExitDump() {},
    nimbusDebug: false,
  };
  const { pid } = processes.spawn('node x.js', [], '/');
  const gate = holdingGate();
  processes.setOutputGate(gate.gate);
  gate.hold(pid);
  const out = _rpcStdout(host, pid, bytes('printed\n'));
  const exit = _rpcReportExit(host, pid, 2, '');
  await turns();
  assert.deepEqual(writes, [], 'nothing reaches the terminal while the output is held');
  assert.deepEqual(notices, []);
  assert.equal(processes.getExit(pid), null, 'the exit is held behind the output');
  gate.release(pid);
  await Promise.all([out, exit]);
  assert.deepEqual(writes, ['printed\r\n']);
  assert.equal(processes.getExit(pid)?.code, 2);
  assert.deepEqual(notices.map((n) => n.kind), ['facet'], 'the exit notice comes with the released exit');

  const shellExec = processes.spawn('npm run x', [], '/').pid;
  gate.hold(shellExec);
  processes.markExit(shellExec, 1);
  _emitShellExecDone(host, shellExec, 'npm run x', 1, 5);
  await turns();
  assert.equal(notices.length, 1, "a shell command's exit notice is held too");
  gate.release(shellExec);
  await turns();
  assert.deepEqual(notices.map((n) => n.kind), ['facet', 'shell']);
  assert.equal(processes.getExit(shellExec)?.code, 1);
}

// A pipe: the parent reads nothing of its child's held output, and the child's end comes after it.
{
  const processes = new SessionProcessSupervisor();
  const parent = processes.spawn('parent', [], '/').pid;
  const gate = holdingGate();
  processes.setOutputGate(gate.gate);
  let childPid = 0;
  let ran = () => {};
  const wrote = new Promise((r) => { ran = r; });
  const broker = new FacetProcessManager({
    processes, vfsForProcess() {}, facetMgr: { kill() { return true; } },
    commandRegistry: {
      async resolve() { return { kind: 'pure-builtin' }; },
      async runPureBuiltin(pid, _name, _args, _env, _cwd, _stdin, hooks) {
        gate.hold(pid);
        const written = hooks.onStdout(bytes('piped'));
        ran();
        await written;
        return 0;
      },
    },
  });
  ({ childPid } = await broker.spawn({ parentPid: parent, command: 'producer', args: [], env: {}, cwd: '/', stdio: ['ignore', 'pipe', 'ignore'] }));
  await wrote;
  await turns();
  const early = await broker.readOutput(childPid, 1, 0, 0);
  assert.deepEqual(early.chunks, [], 'the parent reads nothing of held output');
  assert.equal(early.closed, false, 'nor the end of a child whose output is held');
  gate.release(childPid);
  let seq = 0;
  let got = '';
  for (;;) {
    const result = await broker.readOutput(childPid, 1, seq, 1000);
    for (const chunk of result.chunks) got += text(chunk.data);
    seq = result.maxSeq;
    if (result.closed) break;
  }
  assert.equal(got, 'piped');
  assert.equal((await broker.wait(childPid, 1000)).exitCode, 0);
}

// A child's end is published with its output: a child that printed nothing,
// and a killed one, are neither done (cpWait) nor closed (cpReadOutput,
// cpDrainOutput) while the gate holds them.
{
  const processes = new SessionProcessSupervisor();
  const parent = processes.spawn('parent', [], '/').pid;
  const gate = holdingGate();
  processes.setOutputGate(gate.gate);
  const killed = [];
  const broker = new FacetProcessManager({
    processes, vfsForProcess() {}, facetMgr: { kill(pid) { killed.push(pid); return true; } },
    commandRegistry: {
      async resolve() { return { kind: 'pure-builtin' }; },
      async runPureBuiltin(pid, name) {
        gate.hold(pid);
        if (name === 'silent') return 0;
        await new Promise(() => {});
      },
    },
  });
  const unpublished = async (childPid, what) => {
    assert.equal((await broker.wait(childPid, 0)).done, false, `${what}: not done while held`);
    assert.equal((await broker.readOutput(childPid, 1, 0, 0)).closed, false, `${what}: its stdout not closed while held`);
    const drained = await broker.drainOutput(childPid);
    assert.equal(drained.stdoutClosed || drained.stderrClosed, false, `${what}: not closed to a drain while held`);
    assert.equal(processes.getExit(childPid), null, `${what}: no exit recorded while held`);
    assert.equal(processes.published(childPid)?.state, 'running', `${what}: shown running while held`);
    assert.notEqual(processes.get(childPid)?.state, 'running', `${what}: its lifecycle ended, what it held released`);
  };
  const silent = (await broker.spawn({ parentPid: parent, command: 'silent', args: [], env: {}, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })).childPid;
  await turns();
  await unpublished(silent, 'a child that printed nothing');
  gate.release(silent);
  assert.deepEqual(await broker.wait(silent, 1000), { done: true, exitCode: 0, signal: null });

  const hung = (await broker.spawn({ parentPid: parent, command: 'hung', args: [], env: {}, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })).childPid;
  await turns();
  assert.equal(broker.kill(hung, 'SIGKILL'), true);
  assert.equal(broker.kill(hung, 'SIGTERM'), false, 'its end is decided: a second kill finds it ending');
  assert.deepEqual(killed, [hung]);
  await unpublished(hung, 'a killed child');
  gate.release(hung);
  const ended = await broker.wait(hung, 1000);
  assert.equal(ended.done, true);
  assert.equal(ended.signal, 'SIGKILL');
  assert.equal((await broker.readOutput(hung, 1, 0, 0)).closed, true);
}

// The shell's own frames: its output and its completion events go out in order, once released.
{
  const processes = new SessionProcessSupervisor();
  const shell = processes.spawn('sh', ['sh'], '/').pid;
  const gate = holdingGate();
  processes.setOutputGate(gate.gate);
  const sent = [];
  const scrollback = [];
  const terminal = new WebSocketTerminal(
    { send: (frame) => sent.push(JSON.parse(frame)) },
    (data) => scrollback.push(data),
    (send) => void processes.releaseOutput(shell, send),
  );
  gate.hold(shell);
  terminal.write('saved\r\n');
  terminal.flushNow();
  terminal.shellIntegration({ type: 'shell-integration', event: 'finish', submissionId: 's1', exitCode: 0 });
  terminal.write('$ ');
  await turns();
  assert.deepEqual(sent, [], 'no frame of the shell leaves while its output is held');
  assert.deepEqual(scrollback, []);
  gate.release(shell);
  await turns();
  assert.deepEqual(sent, [
    { type: 'output', data: 'saved\r\n' },
    { type: 'shell-integration', event: 'finish', submissionId: 's1', exitCode: 0 },
    { type: 'output', data: '$ ' },
  ]);
  assert.deepEqual(scrollback, ['saved\r\n', '$ ']);
}

console.log('process-output-gate: held output, pipes, terminal frames and exits wait for the gate, in order');
