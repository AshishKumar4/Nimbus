#!/usr/bin/env bun
/**
 * cpython-resident-boot — a resident Python process whose start failed is a
 * failed process, whatever it left listening.
 *
 * The start's result carries an error when something ended the run badly,
 * a write the session refused while the run settled among them
 * (cpython-preamble.ts __nimbusPySettled). The router (cpython-resident.ts
 * startResidentCPython) must end that process and report the error by name,
 * before advertising any port: a server whose boot lost a write must not look
 * started, and a script's named failure must not come back nameless.
 */

import assert from 'node:assert/strict';
import { cpythonResidentStart } from '../../packages/worker/src/runtime/cpython-resident.ts';

const refused = 'home/user/state.json: not written (ENOSPC: no space left on device)';

/** A manager whose spawned process booted to `boot`; `ended`, the status it had already ended with as its boot settled. */
function facetManager(boot, ended = null) {
  const calls = { finished: [], registered: [], killed: [] };
  const manager = {
    async spawnWorker() { return { pid: 1000007, boot }; },
    processExitCode() { return ended; },
    finishProcess(pid, code, message) { calls.finished.push({ pid, code, message }); },
    async registerPort(pid, port) { calls.registered.push({ pid, port }); },
    async waitForRouteablePorts() { return [8080]; },
    kill(pid) { calls.killed.push(pid); },
  };
  return { manager, calls };
}

const args = {
  command: 'python3 server.py', cwd: '/home/user', argv: ['python3', 'server.py'], invokerPid: 7,
  wasmVfsPath: 'usr/lib/nimbus/cpython/3.13.14/share/cpython/python.wasm',
  startArgs: { userEnv: {} },
};

{
  const { manager, calls } = facetManager({
    state: 'listening', port: 8080, stdout: 'serving\n', stderr: '',
    result: { exitCode: 1, error: refused },
  });
  const result = await cpythonResidentStart(manager)(args);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /state\.json: not written \(ENOSPC/);
  assert.equal(result.port, undefined, 'no port is reported');
  assert.deepEqual(calls.registered, [], 'no port is advertised');
  assert.deepEqual(calls.finished, [{ pid: 1000007, code: 1, message: refused }], 'the process is ended');
  console.log('  ok  a server whose start lost a write is ended, named, and never advertised');
}

{
  const { manager, calls } = facetManager({
    state: 'exited', stdout: 'done\n', stderr: '',
    result: { exitCode: 1, error: refused },
  });
  const result = await cpythonResidentStart(manager)(args);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /state\.json: not written/);
  assert.equal(calls.finished[0].message, refused);
  console.log('  ok  a script whose run lost a write fails with the write named');
}

{
  const { manager, calls } = facetManager({ state: 'listening', port: 8080, stdout: '', stderr: '', result: { exitCode: 0 } });
  const result = await cpythonResidentStart(manager)(args);
  assert.equal(result.exitCode, 0);
  assert.equal(result.port, 8080);
  assert.deepEqual(calls.registered, [{ pid: 1000007, port: 8080 }]);
  console.log('  ok  a server that started cleanly is advertised as before');
}

// Its program ended unsuccessfully after it registered a server (an
// uncaught KeyboardInterrupt): it is no server, and ends with its status.
{
  const { manager, calls } = facetManager({
    state: 'listening', port: 8080, stdout: '', stderr: 'KeyboardInterrupt\n',
    result: { exitCode: 130 },
  });
  const result = await cpythonResidentStart(manager)(args);
  assert.equal(result.exitCode, 130);
  assert.equal(result.port, undefined, 'no port is reported');
  assert.deepEqual(calls.registered, [], 'no port is advertised');
  assert.equal(calls.finished[0]?.code, 130, 'the process ends with its status');
  console.log('  ok  an interrupted program that registered a server is none, and ends with its status');
}

// It had already ended as its boot settled (a signal it never took, given its
// default action as it went to the background): that status is its own.
{
  const { manager, calls } = facetManager({ state: 'listening', port: 8080, stdout: 'serving\n', stderr: '', result: { exitCode: 0 } }, 130);
  const result = await cpythonResidentStart(manager)(args);
  assert.equal(result.exitCode, 130);
  assert.equal(result.stdout, 'serving\n', 'with what it printed');
  assert.deepEqual(calls.registered, [], 'no port is advertised');
  console.log('  ok  a process that ended as its boot settled reports the status it ended with');
}

console.log('cpython-resident-boot: all cases passed');
