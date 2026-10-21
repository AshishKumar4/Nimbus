#!/usr/bin/env bun
// A Node program's run that stops (a synchronous read it waits for, a
// listen) and is run again (Kinu ask 67.4): what it catches waits for the run
// that comes next (SessionProcessSupervisor.parkSignals):
//   - the stopped run's wait for a signal is answered none, and a signal it
//     was given but did not ask past goes back to the front, not lost;
//   - a signal sent while it is parked is queued, not given to a wait nor to
//     its input (the next run's preparation reads input before its handlers
//     are there);
//   - the next run's word of what it catches does not take the box back (it
//     says so as it starts, before a replay's boundary); its first take past
//     the boundary does, and the signal is its;
//   - a signal its input wait gave back when data won is the queue's alone: a
//     park does not queue it twice.
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
  processes.openInput(pid);
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
  processes.takeSignalsBack(pid);
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
  assert.deepEqual([packet.signal, new TextDecoder().decode(typeof packet.data === 'string' ? new TextEncoder().encode(packet.data) : packet.data)], [undefined, 'x'],
    `the next run's preparation reads its input, no signal: ${JSON.stringify(packet)}`);
  processes.catchSignals(pid, ['SIGTERM', 'SIGINT']);
  processes.writeInput(pid, 'y');
  const again = await within(1000, processes.readInput(pid, 100));
  assert.equal(again.signal, undefined, `its word of what it catches leaves it parked: ${JSON.stringify(again)}`);
  processes.takeSignalsBack(pid);
  assert.equal(await within(1000, processes.nextSignal(pid, 50)), 'SIGINT', 'taken back past its boundary, it is the run\'s');
});

await check('a signal given back when data won is queued once', async () => {
  const { processes, pid } = running();
  // Its data already there as it reads, and the signal the moment after: both answer, and the data's first.
  processes.writeInput(pid, 'data');
  const reading = processes.readInput(pid, 1000);
  processes.signal(pid, 'SIGTERM');
  const packet = await within(1000, reading);
  assert.equal(packet.signal, undefined, `data won: ${JSON.stringify(packet)}`);
  processes.parkSignals(pid);
  processes.takeSignalsBack(pid);
  assert.equal(await within(1000, processes.nextSignal(pid, 50)), 'SIGTERM');
  assert.equal(await within(1000, processes.nextSignal(pid, 50)), null, 'once');
});

await check('parked with its stopped run\'s word of what it catches, it stays parked', async () => {
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('node', ['node', 'main.js'], '/home/user', {});
  processes.openInput(pid);
  processes.parkSignals(pid, ['SIGTERM']);
  assert.deepEqual(processes.signal(pid, 'SIGTERM'), { ok: true }, 'caught: queued, not its end');
  processes.writeInput(pid, 'x');
  const packet = await within(1000, processes.readInput(pid, 100));
  assert.equal(packet.signal, undefined, `still parked: ${JSON.stringify(packet)}`);
  processes.takeSignalsBack(pid);
  assert.equal(await within(1000, processes.nextSignal(pid, 50)), 'SIGTERM');
});

assert.deepEqual(failures, []);
console.log('process-signal-parking: a stopped run\'s signals wait for the run that comes next');
