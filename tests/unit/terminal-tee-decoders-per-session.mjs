#!/usr/bin/env bun
// A background process's output, mirrored to its session's terminal, is
// decoded by that session alone (SES-3). Two sessions in one isolate number
// their processes alike, so each has the same pid: a character one session's
// process splits across two writes is still one character, whatever the
// other's process writes between them, and one session's process ending
// takes nothing of the other's. A process killed (not reporting its own
// exit) leaves no decoder behind, and writes nothing after its end.
//
// Through the real _rpcStdout, two hosts over their own process tables.
// Red before: one decoder per pid and stream for the whole isolate: B's
// 'x' landed after A's pending E2 byte (a replacement character on B's
// terminal), A's continuation decoded alone.
import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _rpcStdout } from '../../packages/worker/src/session/rpc.ts';

function session() {
  const writes = [];
  const processes = new SessionProcessSupervisor();
  return {
    writes,
    host: {
      processes,
      terminal: { write: (data) => writes.push(data) },
      shell: { queueProcessExitNotice() { return true; }, writeNotice() {} },
      nimbusDebug: false,
    },
  };
}
const euro = new TextEncoder().encode('€');

{
  const a = session();
  const b = session();
  const pa = a.host.processes.spawn('server-a', [], '/home/user', { longRunning: true }).pid;
  const pb = b.host.processes.spawn('server-b', [], '/home/user', { longRunning: true }).pid;
  assert.equal(pa, pb, 'the two sessions number their first process alike');

  await _rpcStdout(a.host, pa, euro.subarray(0, 1));
  await _rpcStdout(b.host, pb, new TextEncoder().encode('x'));
  await _rpcStdout(a.host, pa, euro.subarray(1));
  assert.equal(b.writes.join(''), 'x', "the other session's process writes only its own text");
  assert.equal(a.writes.join(''), '€', "a character split across one process's writes is one character");
}

{
  // A process killed rather than ending by its own report no longer owns
  // the shell: its unfinished character is not written after it ends.
  const a = session();
  const pid = a.host.processes.spawn('server', [], '/home/user', { longRunning: true }).pid;
  await _rpcStdout(a.host, pid, euro.subarray(0, 1));
  a.host.processes.kill(pid);
  await _rpcStdout(a.host, pid, euro.subarray(1));
  assert.equal(a.writes.join(''), '', 'nothing of a killed process reaches the terminal after it ends');
}

{
  // Killed while its output is held: the output held before its end is
  // published before the end, and decodes with the bytes before it. The
  // gate holds the continuation, then everything after it (the published
  // end), each until let go.
  const a = session();
  const pid = a.host.processes.spawn('server', [], '/home/user', { longRunning: true }).pid;
  const gate = (() => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; });
  const continuationGate = gate();
  const endGate = gate();
  let holding = null;
  a.host.processes.setOutputGate({ before: (p) => (p === pid ? holding : null) });
  await _rpcStdout(a.host, pid, euro.subarray(0, 1));
  holding = continuationGate.promise;
  const continuation = _rpcStdout(a.host, pid, euro.subarray(1));
  holding = endGate.promise;
  a.host.processes.kill(pid);
  continuationGate.release();
  await continuation;
  assert.equal(a.writes.join(''), '€', `the held continuation decodes with its first byte: ${JSON.stringify(a.writes)}`);
  holding = null;
  endGate.release();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

console.log('terminal-tee-decoders-per-session: ok');
