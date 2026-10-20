#!/usr/bin/env bun
// A relaunched process gets its environment from its host, never from a
// record, an image or a generated source (ask 62). Through the session's
// manager, over one session's storage and filesystem across resets:
//
//   1. a Node resident started with an env: its start is handed the env, no
//      file of the session holds it, nor does its journal row; the session
//      keeps it in a row of its own object (session/process-env.ts), written
//      with the journal row, so a crash keeps both or neither;
//   2. after a reset the re-drive asks the host, naming the pid, credential
//      and record, and starts with the host's answer: here one unlike the
//      first launch's, so a recovery that read a stale copy would show;
//   3. a host that answers null, throws, or composes no resolver: the
//      re-drive fails, named, and boots nothing;
//   4. the kept environment goes with its record: a killed process leaves
//      none;
//   5. a session an earlier release left: the env its journal row held, a
//      dev server's record held, an application blob held (named by nothing,
//      too), and the generated source holding it, are gone before anything
//      is re-driven, and the relaunch gets the env back from the session's
//      keeping. A file that only looks generated stays: one an application
//      names, or one the kernel does not own;
//   6. a python resident's environment is built again on the host's answer
//      as its first launch built it (an empty PYTHONUNBUFFERED is '1'
//      again), and its image keeps no env: one an earlier release wrote
//      whole keeps the facts it was built from.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { interpreterProcessEnv } from '../../packages/core/src/runtime/interpreter-env.ts';
import { PROCESS_ENV_DROPPED_KEY } from '../../packages/worker/src/session/keys.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const FIRST = 'ask62-first-0b7c';
const SECOND = 'ask62-second-91ae';
const SERVER = "require('http').createServer(() => {}).listen(8080);";
const LAUNCH = { filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js', argv: ['/home/user/app/server.js'] };

/** An instance of `session` at `generation`: what each start was handed in `starts`, the user's notices in `notices`. */
function instance(session, generation, hooks = {}, { crashable = false } = {}) {
  const starts = [];
  const notices = [];
  const evaluate = () => ({
    async startProcess(args) { starts.push(args); return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  });
  const launched = launchManager('process-env-relaunch', {
    session, generation, evaluate, crashable,
    hooks: {
      notify: (line) => notices.push(line),
      requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
      resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(session.vfs, recipe),
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
async function sessionRunning(env, { crashable = false } = {}) {
  const session = launchSession();
  session.vfs.as(CRED_KERNEL).mkdir('home/user/app', { recursive: true, mode: 0o755 });
  const gen1 = instance(session, 1, {}, { crashable });
  const { pid } = await gen1.manager.spawnNode(SERVER, { ...LAUNCH, env });
  await until(() => gen1.starts.length === 1 && session.storage.get(`resident-launch:${pid}`)?.phase === 'running', 'the launch to run');
  return { session, gen1, pid };
}

// ── 1 + 2: kept outside every file, and given back by the host ──────────────
{
  const { session, gen1, pid } = await sessionRunning({ SECRET: FIRST }, { crashable: true });
  // The session is lost now: what it did not sync is gone.
  gen1.ctx.storage.crash();
  assert.deepEqual(keptKeys(session), journalKeys(session).map((key) => `process-env:${key}`), 'the row and its env survive together');
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
  // Its generated source, the env in its arguments: in the image store, and
  // below /var/lib/nimbus, where releases through 0.19 wrote it and no
  // sweep of the store looks.
  const kernel = session.vfs.as(CRED_KERNEL);
  const generated = `const __NIMBUS_ARGS = ${JSON.stringify({ argv: [], env: { SECRET: FIRST } })};\n`;
  const imagePath = facetImagePath(await facetImageDigest(generated)).slice(1);
  for (const dir of ['.nimbus/facet-images', 'var/lib/nimbus/facet-images']) {
    kernel.mkdir(dir, { recursive: true, mode: 0o755 });
    kernel.writeFile(`${dir}/${imagePath.split('/').at(-1)}`, generated, { mode: 0o644 });
  }
  // A dev server's record, and an application blob no index or row names, each with the env in it.
  session.storage.set('dev-server:7', { command: 'vite', env: { SECRET: FIRST } });
  const orphan = JSON.stringify({ modules: {}, env: { SECRET: FIRST }, vfsWasmModules: null });
  kernel.mkdir('.nimbus/images', { recursive: true, mode: 0o755 });
  kernel.writeFile(`.nimbus/images/${await facetImageDigest(orphan)}`, orphan, { mode: 0o644 });
  // Files that only look generated: a text module an application names, and one the kernel does not own.
  const lookalike = `// const __NIMBUS_ARGS = {"argv":[]}\nexport const answer = 42;\n`;
  const named = facetImagePath(await facetImageDigest(lookalike));
  kernel.writeFile(named.slice(1), lookalike, { mode: 0o644 });
  const naming = JSON.stringify({ modules: {}, env: null, vfsWasmModules: null, vfsTextModules: { 'lib.js': named } });
  kernel.writeFile(`.nimbus/images/${await facetImageDigest(naming)}`, naming, { mode: 0o644 });
  const usersOwn = `var/lib/nimbus/facet-images/${await facetImageDigest(generated + ' ')}.js`;
  kernel.writeFile(usersOwn, generated, { mode: 0o644 });
  kernel.chown(usersOwn, 1000, 1000);

  const gen2 = instance(session, 2);
  await gen2.manager.pumpResidentLaunches();
  await until(() => gen2.starts.length === 1, 'the re-drive to start');
  assert.equal(gen2.starts[0].env.SECRET, FIRST, 'the relaunch gets the env the row held, from the session\'s keeping');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [usersOwn], 'the generated sources and the blob that held it are gone, and only a file the kernel does not own is left');
  assert.equal(kernel.exists(named.slice(1)), true, 'a text module an application names stays');
  assert.deepEqual(session.storage.get('dev-server:7'), { command: 'vite' }, 'the dev server\'s record holds no env');
  assert.deepEqual(session.storage.get('process-env:dev-server:7'), { env: { SECRET: FIRST } }, 'which the session keeps beside it');
  assert.equal([...session.storage.entries()].some(([name, value]) => !name.startsWith('process-env:') && JSON.stringify(value).includes(FIRST)), false,
    'and no row but the session\'s keeping holds it');
  console.log('  [5] an earlier release\'s copies are gone before the re-drive, which gets the env back');
}

// ── 6: an interpreter's environment, built again as its first launch did ────
{
  const session = launchSession();
  const kernel = session.vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  const facts = { runtime: 'python', home: '/home/user', cacert: '/usr/lib/python/cacert.pem' };
  const base = { SECRET: FIRST, PYTHONUNBUFFERED: '' };
  const gen1 = instance(session, 1);
  const { pid } = await gen1.manager.spawnWorker('export default {}', 'python app.py', '/home/user/app', {
    resident: { runtime: 'python', argv: ['python', 'app.py'] },
    startArgs: { userEnv: interpreterProcessEnv(base, facts) },
    interpreterEnv: { base, facts },
  });
  await until(() => gen1.starts.length === 1, 'the resident to start');
  assert.equal(gen1.starts[0].userEnv.PYTHONUNBUFFERED, '1', 'its runtime sets what the command left empty');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [], 'its image holds no env');

  const answer = { SECRET: SECOND, PYTHONUNBUFFERED: '' };
  const gen2 = instance(session, 2, { resolveProcessEnv: async () => answer });
  await gen2.manager.pumpResidentLaunches();
  await until(() => gen2.starts.length === 1, 'the re-drive to start');
  assert.deepEqual(gen2.starts[0].userEnv, interpreterProcessEnv(answer, facts), 'the relaunch builds it on the host\'s answer as the first launch built it');

  // Its image as an earlier release wrote it: the environment whole, no facts.
  const key = journalKeys(session)[0];
  const row = session.storage.get(key);
  const blob = JSON.parse(kernel.readFileString(`.nimbus/images/${row.recipe.image.application}`));
  const { envFacts: _facts, ...startArgs } = blob.startArgs;
  const legacy = JSON.stringify({ ...blob, startArgs: { ...startArgs, userEnv: interpreterProcessEnv(base, facts) } });
  const legacyDigest = await facetImageDigest(legacy);
  kernel.writeFile(`.nimbus/images/${legacyDigest}`, legacy, { mode: 0o644 });
  session.storage.set(key, { ...row, recipe: { ...row.recipe, image: { ...row.recipe.image, application: legacyDigest } } });
  session.storage.delete(`process-env:${key}`);
  session.storage.delete(PROCESS_ENV_DROPPED_KEY);
  const gen3 = instance(session, 3, { resolveProcessEnv: async () => answer });
  await gen3.manager.pumpResidentLaunches();
  await until(() => gen3.starts.length === 1, 'the re-drive of the migrated image to start');
  assert.deepEqual(gen3.starts[0].userEnv, interpreterProcessEnv(answer, facts), 'the migrated image keeps the facts its environment was built from');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [], 'and no file holds the env');
  console.log(`  [6] an interpreter's environment is built again on the host's answer (pid ${pid}), from a migrated image too`);
}

console.log('process-env-relaunch: a relaunch gets its env from its host, and nothing a process can read holds it');
