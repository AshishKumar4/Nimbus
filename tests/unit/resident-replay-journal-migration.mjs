#!/usr/bin/env bun
// A promoted resident's journal row holds the replay its start retraces, and
// it outlives the release that wrote it: a server runs on across deploys, and
// a session restart re-drives it from that row. A row an earlier release
// wrote names its replay's boundary by a field beside it (`listen: true`,
// `read`, `stopAt`); the re-drive hands the start today's tagged boundary.
// Read through the real flow: a resident started, its row rewritten as an
// earlier release wrote it, then a later instance re-drives it.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const TAPE = { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [], writes: [] };
const SERVER = "require('http').createServer(() => {}).listen(8080);";
const LAUNCH = { filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js', argv: ['/home/user/app/server.js'] };

/** An instance of `session` at `generation`: what each start was handed in `starts`, the user's notices in `notices`. */
function instance(session, generation) {
  const starts = [];
  const notices = [];
  const launched = launchManager('resident-replay-journal-migration', {
    session, generation,
    evaluate: () => ({
      async startProcess(args) { starts.push(args); return { ok: true }; },
      async handleHttpRequest() { return new Response('ok'); },
    }),
    hooks: {
      notify: (line) => notices.push(line),
      requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
      resolveProcessEnv: async () => ({}),
    },
  });
  return { ...launched, starts, notices };
}

const until = async (ready, what) => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ready(), `timed out waiting for ${what}`);
};

for (const [what, legacy, boundary] of [
  ['a server started again at its listen', { listen: true }, { kind: 'listen' }],
  ['a program started again at a read it missed', { read: 'home/user/data.json' }, { kind: 'read', path: 'home/user/data.json' }],
  ['a program started again at a read of stdin', { stopAt: 2 }, { kind: 'stdin', stopAt: 2 }],
]) {
  const session = launchSession();
  session.vfs.as(CRED_KERNEL).mkdir('home/user/app', { recursive: true, mode: 0o755 });
  const gen1 = instance(session, 1);
  const replay = { run: 2, tape: TAPE, boundary, prefix: { stdout: '', stderr: '' } };
  const { pid } = await gen1.manager.spawnNode(SERVER, { ...LAUNCH, resume: { replay } });
  const key = `resident-launch:${pid}`;
  await until(() => gen1.starts.length === 1 && session.storage.get(key)?.phase === 'running', 'the launch to run');
  assert.deepEqual(gen1.starts[0].replay.boundary, boundary, `${what}: the first start retraces to its boundary`);

  // The row as an earlier release wrote it: the boundary a field beside the replay.
  const row = session.storage.get(key);
  const { boundary: _boundary, ...rest } = row.recipe.opts.resume.replay;
  session.storage.set(key, {
    ...row,
    recipe: { ...row.recipe, opts: { ...row.recipe.opts, resume: { ...row.recipe.opts.resume, replay: { ...rest, ...legacy } } } },
  });

  const gen2 = instance(session, 2);
  await gen2.manager.pumpResidentLaunches();
  await until(() => gen2.starts.length === 1 || /could not be restarted/.test(gen2.notices.join('')), `${what}: the re-drive`);
  assert.deepEqual(gen2.notices.filter((line) => /could not be restarted/.test(line)), [], `${what}: the re-drive does not fail`);
  assert.deepEqual(gen2.starts[0].replay.boundary, boundary, `${what}: the re-drive retraces to the same boundary`);
  for (const field of Object.keys(legacy)) assert.equal(field in gen2.starts[0].replay, false, `${what}: and hands no ${field} beside it`);
}

console.log('resident-replay-journal-migration: a row an earlier release wrote re-drives to its tagged boundary');
