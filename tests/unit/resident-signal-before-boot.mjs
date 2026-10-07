#!/usr/bin/env bun
// A signal to an attached resident whose launch has not booted takes its
// default action now, and the launch stops: no facet is started for a
// process that has already ended.
//
// Live on throwaway nimbus-tw-piinst: SIGTERM sent to `pi` 3 s after
// `[bin started (long-running)]` sat in the process's input queue until
// the facet booted and its stdin pump read it. The exit arrived 39.8 s
// later. A harness that waits 15 s for the exit then saw the first pi
// still 'running', so the next `pi` launched as a non-durable second
// instance.

import assert from 'node:assert/strict';

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const exits = [];
const { world, ctx, processes, manager, vfs } = launchManager('signal-before-boot', {
  hooks: { onExternalExit: (pid, code, reason) => exits.push({ pid, code, reason }) },
});

// The npm-bin runner's shape: the pid exists with its terminal open, then the
// launch is handed to the manager, which returns before building anything.
const entry = processes.spawn('pi', ['/home/user/cli.js'], '/home/user', { longRunning: true, attachedTty: true });
processes.openInput(entry.pid);
await manager.spawnNode('setInterval(() => {}, 1000);', {
  filename: '/home/user/cli.js',
  cwd: '/home/user',
  command: 'pi',
  argv: ['/home/user/cli.js'],
  attachedTty: true,
  skipSpawn: true,
  callerPid: entry.pid,
});

processes.signal(entry.pid, 'SIGTERM');
assert.equal(processes.get(entry.pid)?.state, 'exited', 'SIGTERM ended the process at once');
assert.equal(processes.get(entry.pid)?.exitCode, 143);
assert.equal(processes.getExit(entry.pid)?.code, 143, 'terminal clients are told the exit');
assert.deepEqual(exits, [{ pid: entry.pid, code: 143, reason: 'SIGTERM' }]);

await Promise.all(ctx.waited);
for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 5));
await Promise.all(ctx.waited);
assert.equal(world.boots.length, 0, 'no facet was started for the ended process');
assert.deepEqual(world.liveFacets(), []);

// The same identity launches again as the durable one, not a second instance.
const notices = [];
const again = processes.spawn('pi', ['/home/user/cli.js'], '/home/user', { longRunning: true, attachedTty: true });
processes.openInput(again.pid);
manager.hooks.notify = (line) => notices.push(line);
await manager.spawnNode('setInterval(() => {}, 1000);', {
  filename: '/home/user/cli.js', cwd: '/home/user', command: 'pi', argv: ['/home/user/cli.js'],
  attachedTty: true, skipSpawn: true, callerPid: again.pid,
});
for (let i = 0; i < 400 && world.boots.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(world.boots.length, 1, 'the relaunch boots');
assert.ok(!notices.some((n) => /second instance/.test(n)), notices.join(''));

console.log('resident-signal-before-boot: ok');
process.exit(0);
