#!/usr/bin/env bun
// A promoted server may keep retracing after startProcess has answered its
// boot (stop-replay.ts booted deliberately permits a listen replay to do so).
// If it then diverges, ctx.abort's authenticated stop arrives through the
// host watch as ProcessHostLost. It is not a stop the returned launch can
// handle: the process must end nonzero, retaining why it did not retrace.
//
// Live reproduction: remix-relaunch-promotion, run-again's config write
// overtook +server-build.d.ts after boot. _watchHost accepted the stop as a
// launch control failure and ignored it; the facet was released and its log
// drained, while the process stayed running and its terminal saw no exit.
// Either way it ends, its stderr says why (the rule: no end is silent).
import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { hostActivity } from '../../packages/fabric/src/host-activity.ts';
import { STOP_RECORD_PREFIX } from '../../packages/worker/src/runtime/stop-replay-contracts.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const WHY = 'it changed the filesystem otherwise than the run before it: config write overtook generated types';
const tape = { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [], writes: [] };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

async function lostAfterBoot(authenticated, { stderrRefused = false } = {}) {
  let startedWith;
  const exits = [];
  // A parent that closed the child's stderr reader refuses what is delivered to it (EPIPE).
  const refuse = async () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); };
  const { manager, world, ctx, processes } = launchManager(`late-retrace-${authenticated}-${stderrRefused}`, {
    evaluate: () => ({
      async startProcess(args) { startedWith = args; return { ok: true }; },
      async handleHttpRequest() { return new Response('ok'); },
    }),
    hooks: {
      onExternalExit: (pid, code, reason) => exits.push({ pid, code, reason }),
      ...(stderrRefused ? { deliverOutput: refuse } : {}),
    },
  });
  const { pid } = await manager.spawnNode('setInterval(() => {}, 1000);', {
    command: 'node promoted.js', cwd: '/home/user', argv: ['/home/user/promoted.js'],
    resume: { replay: { run: 2, listen: true, tape, prefix: { stdout: '', stderr: '' } } },
  });
  assert.equal(processes.get(pid)?.state, 'running', 'the resident booted');
  assert.equal(startedWith.replay.listen, true, 'it keeps retracing its first run up to its listen');
  assert.ok(startedWith.stopNonce.length >= 16, 'this launch minted its stop nonce');
  const watching = hostActivity(ctx).acquire();
  try {
    for (const observation of hostActivity(ctx).observations) await observation.current?.ready;
    const nonce = authenticated ? startedWith.stopNonce : 'a-different-launch-0000000000000000';
    const record = { v: 3, run: 2, out: [], kind: 'diverged', why: WHY };
    const stopped = new Error(STOP_RECORD_PREFIX + nonce + ' ' + JSON.stringify(record));
    world.die(world.boots[0].facetName, stopped);
    for (let tries = 0; tries < 400 && processes.get(pid)?.state === 'running'; tries++) await pause();
    const stderr = processes.allLogs(pid).filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.data).join('');
    return { pid, entry: { ...processes.get(pid) }, exit: processes.getExit(pid), exits: [...exits], stderr };
  } finally {
    watching.release();
    manager.kill(pid);
  }
}

// Control: the same host-watch failure, without this launch's nonce, goes
// through the ordinary host-loss path and ends its process, retaining why.
const unrecognized = await lostAfterBoot(false);
assert.equal(unrecognized.entry.state, 'exited');
assert.equal(unrecognized.entry.exitCode, 137);
assert.match(unrecognized.exits[0]?.reason ?? '', /config write overtook generated types/);
assert.match(unrecognized.stderr, /^\[nimbus\] process \d+ ended: its host was reset by the platform/m, `a lost host says so on its stderr: ${JSON.stringify(unrecognized.stderr)}`);
console.log('resident-late-retrace-divergence: unrecognized stop ends through host loss (control green)');

const recognized = await lostAfterBoot(true);
assert.equal(recognized.entry.state, 'exited',
  'an authenticated divergence after boot was swallowed: its facet died but its pid stayed running');
assert.notEqual(recognized.entry.exitCode, 0, 'a resident that did not retrace cannot report success');
assert.match(recognized.exits[0]?.reason ?? '', /config write overtook generated types/,
  'the terminal observer must be told the actual divergence');
assert.equal(recognized.stderr,
  `node: this program listens as a server, so Nimbus ran it again as one, and it did not retrace its run before up to its listen (${WHY}), so it was ended.\n`,
  'its stderr says why it ended');
console.log('resident-late-retrace-divergence: a divergence after boot ends the process and retains its cause');

// Its stderr refused: it ends all the same, and its own log keeps why.
const refused = await lostAfterBoot(true, { stderrRefused: true });
assert.equal(refused.entry.state, 'exited', 'a stop whose word its stderr refused still ends its process');
assert.equal(refused.entry.exitCode, 1);
assert.match(refused.stderr, /did not retrace its run before up to its listen/, 'its log keeps why');
console.log('resident-late-retrace-divergence: a stderr that refuses the word does not keep the process running');
