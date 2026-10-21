#!/usr/bin/env bun
// A Node program's run that stops (a synchronous read it waits for, a
// listen) and is run again (Kinu ask 67.4): what it catches waits for the run
// that comes next (SessionProcessSupervisor.parkSignals):
//   - the stopped run's wait for a signal is answered none, and a signal it
//     was given but did not ask past goes back to the front, not lost;
//   - a signal sent while it is parked is queued, not given to a wait nor to
//     its input (the next run's preparation reads input before its handlers
//     are there);
//   - the next run's word of what it catches, or its first wait, takes the box
//     back, and the signal is its.
import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

const within = (ms, promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms))]);
const failures = [];
const check = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};
/** A running process whose program catches SIGTERM and SIGINT. */
function running() {
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('node', ['node', 'main.js'], '/home/user', {});
  processes.catchSignals(pid, ['SIGTERM', 'SIGINT']);
  return { processes, pid };
}

await check('the stopped run\'s wait is answered none', async () => {
  const { processes, pid } = running();
  const waiting = processes.nextSignal(pid, 5000);
  processes.parkSignals(pid);
  assert.equal(await within(1000, waiting), null);
});

await check('a signal the stopped run was given goes back', async () => {
  const { processes, pid } = running();
  const waiting = processes.nextSignal(pid, 5000);
  processes.signal(pid, 'SIGTERM');
  assert.equal(await waiting, 'SIGTERM', 'given to the run that then stopped');
  processes.parkSignals(pid);
  assert.equal(await within(1000, processes.nextSignal(pid, 5000)), 'SIGTERM', 'the next run takes it');
});

await check('a signal the run asked past is not given again', async () => {
  const { processes, pid } = running();
  const first = processes.nextSignal(pid, 5000);
  processes.signal(pid, 'SIGTERM');
  assert.equal(await first, 'SIGTERM');
  const second = processes.nextSignal(pid, 50);
  assert.equal(await second, null);
  processes.parkSignals(pid);
  assert.equal(await within(1000, processes.nextSignal(pid, 50)), null);
});

await check('parked, a signal waits in the box: not in the input', async () => {
  const { processes, pid } = running();
  processes.parkSignals(pid);
  assert.deepEqual(processes.signal(pid, 'SIGINT'), { ok: true });
  processes.writeInput(pid, 'x');
  const packet = await processes.readInput(pid, 100);
  assert.equal(packet.signal, undefined, `the next run's preparation reads no signal: ${JSON.stringify(packet)}`);
  processes.catchSignals(pid, ['SIGTERM', 'SIGINT']);
  assert.equal(await within(1000, processes.nextSignal(pid, 50)), 'SIGINT', 'the next run, once it says what it catches, takes it');
});

assert.deepEqual(failures, []);
console.log('process-signal-parking: a stopped run\'s signals wait for the run that comes next');
