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
//      dev server's record held, and an application blob held (named by
//      nothing, too, or cut short by a reset), are gone before anything is
//      re-driven, and the relaunch gets the env back from the session's
//      keeping. The generated entries holding it in the image directories
//      (composed recipes, an env owning `__proto__` too) are the embedder's
//      directory's: listed (legacy-images.ts), and the session told how many,
//      never removed here. Module text that declares the same arguments (a
//      block comment, a template, an array expression, one with a trailing
//      comma) is not listed, nor a recipe the kernel does not own; a durable
//      worker whose text module that is relaunches with it;
//   6. a python resident's environment is built again on the host's answer
//      as its first launch built it (an empty PYTHONUNBUFFERED is '1'
//      again), and its image keeps no env. One an earlier release wrote
//      whole keeps no facts to build from: its relaunch runs with the
//      environment the session keeps whole; under an embedder's resolver,
//      which answers a base nothing can build on, it is not restarted, and
//      the user is told.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { interpreterProcessEnv } from '../../packages/core/src/runtime/interpreter-env.ts';
import { ImmutableModuleSource, moduleSource } from '../../packages/platform/src/module-source.ts';
import { PROCESS_ENV_DROPPED_KEY } from '../../packages/worker/src/session/keys.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { legacyGeneratedImages } from '../../packages/worker/src/facets/legacy-images.ts';
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
  const { session, gen1, pid } = await sessionRunning({});
  // The row as an earlier release wrote it, its env inside, and nothing kept beside it.
  const key = `resident-launch:${pid}`;
  const row = session.storage.get(key);
  session.storage.set(key, { ...row, recipe: { ...row.recipe, opts: { ...row.recipe.opts, env: { SECRET: FIRST } } } });
  session.storage.delete(`process-env:${key}`);
  session.storage.delete(PROCESS_ENV_DROPPED_KEY);
  // Its generated entries, the env in their arguments: composed as the
  // store wrote them (a ModuleSourceRecipe's JSON, a library by reference),
  // in /.nimbus and below /var/lib/nimbus, one with an env owning
  // `__proto__` (written as a computed key).
  const kernel = session.vfs.as(CRED_KERNEL);
  const args = { argv: [], env: { SECRET: FIRST }, cwd: '/home/user/app' };
  const library = new ImmutableModuleSource(new TextEncoder().encode('export const shims = 1;\n'), { path: '/node-shims/shims.js', sha256: '0'.repeat(64) });
  const entry = (declared) => JSON.stringify(moduleSource`import { DurableObject } from "cloudflare:workers";\n${library}\nconst __NIMBUS_ARGS = ${declared};\nexport class NimbusProcess extends DurableObject {}\n`.recipe());
  const imageAt = async (dir, image) => {
    kernel.mkdir(dir, { recursive: true, mode: 0o755 });
    const path = facetImagePath(await facetImageDigest(image)).slice(1).replace('.nimbus/facet-images', dir);
    kernel.writeFile(path, image, { mode: 0o644 });
    return path;
  };
  const generated = [
    await imageAt('.nimbus/facet-images', entry(JSON.stringify(args))),
    await imageAt('.nimbus/facet-images', entry(`{"argv":[],"env":{["__proto__"]:"x","SECRET":${JSON.stringify(FIRST)}}}`)),
    await imageAt('var/lib/nimbus/facet-images', entry(JSON.stringify(args))),
  ];
  // A dev server's record, an application blob no index or row names, and
  // one a reset cut short (its bytes not yet what its name says), each with
  // the env in it.
  session.storage.set('dev-server:7', { command: 'vite', env: { SECRET: FIRST } });
  const orphan = JSON.stringify({ modules: {}, env: { SECRET: FIRST }, vfsWasmModules: null });
  kernel.mkdir('.nimbus/images', { recursive: true, mode: 0o755 });
  kernel.writeFile(`.nimbus/images/${await facetImageDigest(orphan)}`, orphan, { mode: 0o644 });
  const whole = JSON.stringify({ modules: { 'a.js': 'x'.repeat(64) }, env: { SECRET: FIRST }, vfsWasmModules: null });
  kernel.writeFile(`.nimbus/images/${await facetImageDigest(whole)}`, whole.slice(0, whole.length / 2), { mode: 0o644 });
  // What only looks generated: module text declaring the same arguments in
  // a block comment and in a template, and a recipe the kernel does not own.
  const commented = await imageAt('.nimbus/facet-images', `/*\nconst __NIMBUS_ARGS = ${JSON.stringify(args)};\n*/\nexport const answer = 42;\n`);
  // An array expression that reads like a recipe's start, naming the
  // secret too, a durable worker's text module: it stays, and the worker
  // relaunches with it.
  const arrayModule = `["\\nconst __NIMBUS_ARGS = ", ${JSON.stringify(FIRST)}]; export const helper = 1;\n`;
  const arrayPath = await imageAt('.nimbus/facet-images', arrayModule);
  const trailing = await imageAt('.nimbus/facet-images', `["\\nconst __NIMBUS_ARGS = ", ${JSON.stringify(FIRST)},]\n`);
  await gen1.manager.spawnWorker('export class NimbusProcess {}', 'durable helper', '/home/user/app', {
    vfsTextModules: { 'helper.js': `/${arrayPath}` }, durable: { owner: 'helper-app' },
  });
  const templated = await imageAt('.nimbus/facet-images', `export const doc = \`\nconst __NIMBUS_ARGS = ${JSON.stringify(args)};\n\`;\n`);
  const usersOwn = await imageAt('var/lib/nimbus/facet-images', entry(JSON.stringify(args)) + ' ');
  kernel.chown(usersOwn, 1000, 1000);

  const gen2 = instance(session, 2);
  await gen2.manager.pumpResidentLaunches();
  await until(() => gen2.starts.some((args) => args?.env !== undefined), 'the node re-drive to start');
  assert.equal(gen2.starts.find((args) => args?.env !== undefined).env.SECRET, FIRST, 'the relaunch gets the env the row held, from the session\'s keeping');
  assert.deepEqual(filesHolding(session.vfs, FIRST).sort(), [...generated, arrayPath, trailing, commented, templated, usersOwn].sort(),
    'the blobs that held it are gone; nothing in the image directories is removed');
  assert.deepEqual(legacyGeneratedImages(session.vfs).sort(), [...generated].sort(), 'the generated entries are listed, and nothing else');
  assert.match(gen2.notices.join(''), /earlier releases left 3 generated program image\(s\)/, 'and the session is told how many');
  await until(() => [...gen2.world.configs.values()].some((config) => config.modules?.['helper.js'] === arrayModule), 'the durable worker to relaunch with its text module');
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
  await until(() => journalKeys(session).length === 1 && journalKeys(session)[0] !== `resident-launch:${pid}`, 'the old record to be superseded');

  // Its image as an earlier release wrote it: the environment whole, no facts.
  const key = journalKeys(session)[0];
  const row = session.storage.get(key);
  const blob = JSON.parse(kernel.readFileString(`.nimbus/images/${row.recipe.image.application}`));
  const { envFacts: _facts, ...startArgs } = blob.startArgs;
  const legacy = JSON.stringify({ ...blob, startArgs: { ...startArgs, userEnv: interpreterProcessEnv(base, facts) } });
  const legacyDigest = await facetImageDigest(legacy);
  kernel.writeFile(`.nimbus/images/${legacyDigest}`, legacy, { mode: 0o644 });
  // A first launch's row (attempt 0): not a restart loop the re-drive guard stops.
  session.storage.set(key, { ...row, attempt: 0, recipe: { ...row.recipe, image: { ...row.recipe.image, application: legacyDigest } } });
  session.storage.delete(`process-env:${key}`);
  session.storage.delete(PROCESS_ENV_DROPPED_KEY);
  const legacyRows = new Map(session.storage);
  const gen3 = instance(session, 3);
  await gen3.manager.pumpResidentLaunches();
  await until(() => gen3.starts.length === 1, 'the re-drive of the migrated image to start');
  assert.deepEqual(gen3.starts[0].userEnv, interpreterProcessEnv(base, facts), 'the migrated image runs with the environment the session keeps whole');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [], 'and no file holds it');
  await until(() => journalKeys(session).length === 1 && journalKeys(session)[0] !== key, 'the migrated record to be superseded');

  // The same session under an embedder that keeps nothing here, and answers a base.
  session.storage.clear();
  for (const [name, value] of legacyRows) session.storage.set(name, value);
  kernel.writeFile(`.nimbus/images/${legacyDigest}`, legacy, { mode: 0o644 });
  const told = [];
  const gen4 = launchManager('process-env-relaunch', {
    session, generation: 4, evaluate: () => ({ async startProcess() { return { ok: true }; } }),
    hooks: {
      resolveProcessEnv: async () => answer,
      keepProcessEnv: undefined,
      resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(session.vfs, recipe),
      notify: (line) => { told.push(line); },
    },
  });
  await gen4.manager.pumpResidentLaunches();
  await until(() => told.length > 0, 'the user to be told');
  assert.match(told.join(''), /"python app\.py" is not restarted: its image held its environment/, 'it is not restarted, and the user is told');
  assert.equal(journalKeys(session).length, 0, 'its row is gone');
  assert.deepEqual(filesHolding(session.vfs, FIRST), [], 'and no file holds its environment');
  console.log(`  [6] an interpreter's environment is built again on the host's answer (pid ${pid}), from a migrated image too`);
}

console.log('process-env-relaunch: a relaunch gets its env from its host, and nothing a process can read holds it');
