#!/usr/bin/env bun
// A relaunched process gets its environment from its host, never from a
// record, an image or a generated source (ask 62). Through the session's
// manager, over one session's storage and filesystem across resets:
//
//   1. a Node resident started with an env: its start is handed the env, no
//      file of the session holds it, nor does its journal row; the session
//      keeps it in a row of its own object (session/process-env.ts);
//   2. after a reset the re-drive asks the host, naming the pid, credential
//      and record, and starts with the host's answer: here one unlike the
//      first launch's, so a recovery that read a stale copy would show;
//   3. a host that answers null, throws, or composes no resolver: the
//      re-drive fails, named, and boots nothing;
//   4. the kept environment goes with its record: a killed process leaves
//      none;
//   5. a session an earlier release left: the env its journal row held, and
//      the generated source holding it, are gone before anything is
//      re-driven; the relaunch gets the env back from the session's keeping,
//      and an embedder's text module beside that source stays.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { PROCESS_ENV_DROPPED_KEY } from '../../packages/worker/src/session/keys.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const FIRST = 'ask62-first-0b7c';
const SECOND = 'ask62-second-91ae';
const SERVER = "require('http').createServer(() => {}).listen(8080);";
const LAUNCH = { filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js', argv: ['/home/user/app/server.js'] };

/** An instance of `session` at `generation`: what each start was handed in `starts`, the user's notices in `notices`. */
function instance(session, generation, hooks = {}) {
  const starts = [];
  const notices = [];
  const evaluate = () => ({
    async startProcess(args) { starts.push(args); return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  });
  const launched = launchManager('process-env-relaunch', {
    session, generation, evaluate,
    hooks: {
      notify: (line) => notices.push(line),
      requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
      ...hooks,
    },
  });
  return { ...launched, starts, notices };
}

const until = async (ready, what) => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ready(), `timed out waiting for ${what}`);
};
const journalKeys = (session) => [...session.storage.keys()].filter((key) => key.startsWith('resident-launch:'));
const keptKeys = (session) => [...session.storage.keys()].filter((key) => key.startsWith('process-env:'));

/** Every file of the session's filesystem whose bytes hold `text`. */
function filesHolding(vfs, text) {
  const kernel = vfs.as(CRED_KERNEL);
  const found = [];
  for (let after = null, page; (page = kernel.list(after)), true; after = page.next) {
    for (const entry of page.entries) {
      const path = entry.path.replace(/^\/+/, '');
      if (entry.kind === 'file' && new TextDecoder().decode(kernel.readFile(path)).includes(text)) found.push(path);
    }
    if (page.next === null) break;
  }
  return found;
}

/** A session whose generation-1 instance started SERVER with `env`, and the pid it runs under. */
async function sessionRunning(env) {
  const session = launchSession();
  session.vfs.as(CRED_KERNEL).mkdir('home/user/app', { recursive: true, mode: 0o755 });
  const gen1 = instance(session, 1);
  const { pid } = await gen1.manager.spawnNode(SERVER, { ...LAUNCH, env });
  await until(() => gen1.starts.length === 1 && session.storage.get(`resident-launch:${pid}`)?.phase === 'running', 'the launch to run');
  return { session, gen1, pid };
}

// ── 1 + 2: kept outside every file, and given back by the host ──────────────
{
  const { session, gen1, pid } = await sessionRunning({ SECRET: FIRST });
  assert.equal(gen1.starts[0].env.SECRET, FIRST, 'the start is handed the env');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [], 'no file of the session holds it');
  assert.equal(JSON.stringify(session.storage.get(`resident-launch:${pid}`)).includes(FIRST), false, 'nor does its journal row');
  assert.deepEqual(session.storage.get(`process-env:resident-launch:${pid}`), { env: { SECRET: FIRST } }, 'the session keeps it in its own object');
  const { cred } = session.storage.get(`resident-launch:${pid}`);

  const asked = [];
  const gen2 = instance(session, 2, {
    resolveProcessEnv: async (request) => { asked.push(request); return { SECRET: SECOND }; },
  });
  await gen2.manager.pumpResidentLaunches();
  await until(() => gen2.starts.length === 1, 'the re-drive to start');
  assert.deepEqual(asked, [{ pid, cred, record: `resident-launch:${pid}` }], 'the host is asked once, about the process it relaunches');
  assert.equal(gen2.starts[0].env.SECRET, SECOND, 'and its answer is the env the relaunch starts with');
  await until(() => journalKeys(session).length === 1 && keptKeys(session).length === 1, 'the old record to be superseded');
  const [relaunched] = journalKeys(session);
  assert.notEqual(relaunched, `resident-launch:${pid}`, 'the relaunch is journalled under its own pid');
  assert.deepEqual(keptKeys(session), [`process-env:${relaunched}`], 'the old record\'s env went with it');
  assert.deepEqual(filesHolding(session.vfs, SECOND), [], 'and no file holds the new one');
  console.log('  [1] the env is handed to the start and kept outside every file; [2] a reset asks the host for it again');
}

// ── 3: no answer, no relaunch ───────────────────────────────────────────────
for (const [what, resolveProcessEnv, reason] of [
  ['answers null', async () => null, /the host gave no environment for it/],
  ['throws', async () => { throw new Error('vault sealed'); }, /the host's resolveProcessEnv failed: vault sealed/],
  ['composes none', undefined, /this host keeps no process's environment and composes no resolveProcessEnv/],
]) {
  const { session } = await sessionRunning({ SECRET: FIRST });
  const gen2 = instance(session, 2, { resolveProcessEnv });
  await gen2.manager.pumpResidentLaunches();
  await until(() => /could not be restarted/.test(gen2.notices.join('')), `the failure to be told (${what})`);
  assert.equal(gen2.starts.length, 0, `a host that ${what}: nothing is booted`);
  assert.match(gen2.notices.join(''), reason, `a host that ${what}: the user is told why`);
  await until(() => journalKeys(session).length === 0, `the failed record to go (${what})`);
  assert.deepEqual(keptKeys(session), [], `a host that ${what}: the record's env goes with it`);
}
console.log('  [3] a host that answers null, throws or composes no resolver fails the relaunch, named');

// ── 4: a killed process leaves no env behind ────────────────────────────────
{
  const { session, gen1, pid } = await sessionRunning({ SECRET: FIRST });
  gen1.manager.kill(pid);
  await until(() => journalKeys(session).length === 0, 'the killed process\'s record to go');
  assert.deepEqual(keptKeys(session), [], 'and its env with it');
  console.log('  [4] a killed process leaves no env behind');
}

// ── 5: what an earlier release left is gone before anything re-drives ───────
{
  const { session, pid } = await sessionRunning({});
  // The row as an earlier release wrote it, its env inside, and nothing kept beside it.
  const key = `resident-launch:${pid}`;
  const row = session.storage.get(key);
  session.storage.set(key, { ...row, recipe: { ...row.recipe, opts: { ...row.recipe.opts, env: { SECRET: FIRST } } } });
  session.storage.delete(`process-env:${key}`);
  session.storage.delete(PROCESS_ENV_DROPPED_KEY);
  // Its generated source, the env in its arguments, and an embedder's text module beside it.
  const kernel = session.vfs.as(CRED_KERNEL);
  kernel.mkdir('.nimbus/facet-images', { recursive: true, mode: 0o755 });
  const generated = `const __NIMBUS_ARGS = ${JSON.stringify({ argv: [], env: { SECRET: FIRST } })};\n`;
  const textModule = 'export const answer = 42;\n';
  const generatedPath = facetImagePath(await facetImageDigest(generated)).slice(1);
  const textPath = facetImagePath(await facetImageDigest(textModule)).slice(1);
  kernel.writeFile(generatedPath, generated, { mode: 0o644 });
  kernel.writeFile(textPath, textModule, { mode: 0o644 });

  const gen2 = instance(session, 2);
  await gen2.manager.pumpResidentLaunches();
  await until(() => gen2.starts.length === 1, 'the re-drive to start');
  assert.equal(gen2.starts[0].env.SECRET, FIRST, 'the relaunch gets the env the row held, from the session\'s keeping');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [], 'the generated source that held it is gone');
  assert.equal(kernel.exists(textPath), true, 'an embedder\'s text module beside it stays');
  assert.equal([...session.storage.entries()].some(([name, value]) => !name.startsWith('process-env:') && JSON.stringify(value).includes(FIRST)), false,
    'and no row but the session\'s keeping holds it');
  console.log('  [5] an earlier release\'s copies are gone before the re-drive, which gets the env back');
}

console.log('process-env-relaunch: a relaunch gets its env from its host, and nothing a process can read holds it');
