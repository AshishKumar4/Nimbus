#!/usr/bin/env bun
// A Node process catches the signals it listens for (Kinu ask 67.4): its
// process's listeners say so to the session (cpCatchSignals) as they come
// and go, and it takes each signal the session queues for it (cpTakeSignal),
// its handlers deciding what it does; a SIGTERM it has stopped listening for
// takes the default action; with none left it stops asking, and holds nothing open. A session that holds no catches for it, answering
// none at once, is asked again a second later, not in a tight loop. What it
// catches is said again until the session takes it, and its output waits for
// that, so a "ready" it prints is seen only once it is caught. The generated
// shims run here over a stand-in supervisor.
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const make = (supervisor) => new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__nimbusProcessId',
  'const __pendingIO = [];' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\nreturn { proc: __processMod, outputGate: __nimbusOutputGate };')({}, {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user', 4321);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

await check('listeners say what it catches; a queued signal reaches them', async () => {
  const said = [];
  const queued = [];
  let waiting = null;
  const supervisor = {
    cpCatchSignals: async (catches) => { said.push([...catches]); },
    cpTakeSignal: (waitMs) => new Promise((resolve) => {
      if (queued.length > 0) { resolve(queued.shift()); return; }
      waiting = resolve;
      setTimeout(() => { if (waiting === resolve) { waiting = null; resolve(null); } }, Math.min(waitMs, 50));
    }),
  };
  const send = (signal) => { if (waiting) { const take = waiting; waiting = null; take(signal); } else queued.push(signal); };
  const { proc } = make(supervisor);
  const heard = [];
  const onTerm = () => heard.push('SIGTERM');
  proc.on('SIGTERM', onTerm);
  proc.once('SIGUSR1', () => heard.push('SIGUSR1'));
  for (let i = 0; i < 100 && said.length < 2; i++) await sleep(10);
  assert.deepEqual(said, [['SIGTERM'], ['SIGUSR1', 'SIGTERM']], 'said as each is added, one after another');
  send('SIGTERM');
  send('SIGUSR1');
  for (let i = 0; i < 100 && heard.length < 2; i++) await sleep(10);
  assert.deepEqual(heard, ['SIGTERM', 'SIGUSR1'], 'its handlers hear them');
  for (let i = 0; i < 100 && said.at(-1)?.length !== 1; i++) await sleep(10);
  assert.deepEqual(said.at(-1), ['SIGTERM'], 'a once listener gone, it no longer catches its signal');
  proc.off('SIGTERM', onTerm);
  for (let i = 0; i < 100 && said.at(-1)?.length !== 0; i++) await sleep(10);
  assert.deepEqual(said.at(-1), [], 'none left: it catches none');
});

await check('none answered at once is not asked again at once', async () => {
  let asked = 0;
  const supervisor = {
    cpCatchSignals: async () => {},
    cpTakeSignal: async () => { asked++; return null; },
  };
  const { proc } = make(supervisor);
  const handler = () => {};
  proc.on('SIGINT', handler);
  await sleep(300);
  proc.off('SIGINT', handler);
  assert.ok(asked <= 2, `asked ${asked} times in 300 ms`);
});

await check('said again until taken; output waits for it', async () => {
  const events = [];
  let tries = 0;
  const supervisor = {
    cpCatchSignals: async (catches) => {
      tries++;
      await sleep(30);
      if (tries < 3) throw new Error('the session was busy');
      events.push(`caught ${catches.join(',')}`);
    },
    cpTakeSignal: (waitMs) => new Promise((resolve) => setTimeout(() => resolve(null), Math.min(waitMs, 50))),
  };
  const { proc, outputGate } = make(supervisor);
  const handler = () => {};
  proc.on('SIGTERM', handler);
  // An output's gate, taken as it is written (the facet's output queue waits for it before it sends).
  await outputGate();
  events.push('ready out');
  const triedBeforeReady = tries;
  proc.off('SIGTERM', handler);
  assert.deepEqual([triedBeforeReady, events], [3, ['caught SIGTERM', 'ready out']]);
});

assert.deepEqual(failures, []);
console.log('node-shims-signal-catching: a Node process catches the signals it listens for and takes them itself');
