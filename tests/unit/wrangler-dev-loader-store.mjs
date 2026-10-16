#!/usr/bin/env bun
// A `nimbus wrangler dev` build's worker_loaders bindings are owners of the
// session's loader code store (FAB-2): each build mints one per binding with
// its env. The build that serves commits them, as it publishes its stub and
// before it says "Worker built". A build whose load the loader refuses (a
// nested shim's admission), or one that something newer superseded, releases
// them, and the serving build's owners are untouched. stop() stops the
// server's owners.

import assert from 'node:assert/strict';
import { NimbusWrangler } from '../../packages/worker/src/wrangler/nimbus-wrangler.ts';

const events = [];
/** Build errors other than the loader's refusal: none expected. */
const errors = [];
let minted = 0;
const registry = {
  mint(_wranglerId, binding) { const token = `t${++minted}`; events.push(['mint', binding, token]); return token; },
  commit(_wranglerId, tokens) { events.push(['commit', ...tokens]); },
  release(token) { events.push(['release', token]); },
  stop() { events.push(['stop']); },
};
let refuse = false;
let held = null;
const loader = {
  // A native loader answers a stub; a nested shim's answers once it admitted the code, or refuses it.
  load() {
    if (refuse) return Promise.reject(new Error('the upstream loader refused this Worker'));
    const stub = { getEntrypoint: () => ({}) };
    return held === null ? stub : held.then(() => stub);
  },
};

const ROOT = 'home/user/app';
const ENTRY = `${ROOT}/src/index.js`;
const files = new Map([
  [`${ROOT}/wrangler.jsonc`, JSON.stringify({
    name: 'app', main: 'src/index.js', compatibility_date: '2026-04-01',
    worker_loaders: [{ binding: 'LOADER' }, { binding: 'CHILD' }],
  })],
  [ENTRY, 'export default { fetch() { return new Response("v1"); } };'],
]);
let deliver = () => {};
let requested = () => {};
const server = new NimbusWrangler({
  vfs: { exists: (path) => files.has(path), readFileString: (path) => files.get(path) },
  bundleFs: {},
  namespace: { watchChanges(_path, listener) { deliver = listener; return () => {}; } },
  esbuild: {
    build([entry]) {
      requested();
      return Promise.resolve({ errors: [], warnings: [], outputFiles: [{ contents: files.get(entry) }] });
    },
  },
  env: { LOADER: loader },
  ctx: { id: { toString: () => 'wrangler-loader-store-object' }, exports: { NimbusLoaderRPC: (options) => options } },
  loaderStore: registry,
  network: { id: 'workspace' },
  root: `/${ROOT}`,
  onLog: (message) => {
    if (/Worker built/.test(message)) events.push(['built']);
    else if (/Build error/.test(message)) {
      events.push(['error']);
      if (!/upstream loader refused/.test(message)) errors.push(message);
    }
  },
  onHmrMessage: () => {},
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(ready, what) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await settle()) if (ready()) return;
  assert.fail(`timed out: ${what}`);
}
/** Change the entry, and wait for the rebuild it starts to ask for its bundle. */
async function change(version) {
  files.set(ENTRY, `export default { fetch() { return new Response("${version}"); } };`);
  const asked = new Promise((resolve) => { requested = resolve; });
  deliver([{ type: 'change', path: `/${ENTRY}` }]);
  await asked;
}
const since = (mark) => events.slice(mark);

// ── a build its loader refuses releases what it minted ────────────────────
refuse = true;
assert.equal(await server.start(), false, 'the refused build does not serve');
assert.deepEqual(errors, [], 'the build fails only at its refused load');
assert.deepEqual(events, [['mint', 'LOADER', 't1'], ['mint', 'CHILD', 't2'], ['error'], ['release', 't1'], ['release', 't2']],
  'one owner per binding, minted with the env, both released when the load is refused');
server.stop();
assert.deepEqual(events.at(-1), ['stop'], 'stop() stops the server\'s owners');

// ── the build that serves commits its owners, before it says "Worker built" ─
refuse = false;
let mark = events.length;
assert.equal(await server.start(), true);
assert.deepEqual(since(mark), [['mint', 'LOADER', 't3'], ['mint', 'CHILD', 't4'], ['commit', 't3', 't4'], ['built']]);

// ── a rebuild its loader refuses releases its own owners, not the serving build's ─
mark = events.length;
refuse = true;
await change('v2');
await until(() => since(mark).some(([kind]) => kind === 'error'), 'the refused rebuild');
await until(() => since(mark).filter(([kind]) => kind === 'release').length === 2, 'its owners released');
assert.deepEqual(since(mark), [['mint', 'LOADER', 't5'], ['mint', 'CHILD', 't6'], ['error'], ['release', 't5'], ['release', 't6']]);
refuse = false;

// ── a rebuild a later one overtook, its load held, releases its owners ─────
mark = events.length;
let open;
held = new Promise((resolve) => { open = resolve; });
await change('v3');
await until(() => since(mark).filter(([kind]) => kind === 'mint').length === 2, 'the held rebuild mints');
held = null;
await change('v4');
await until(() => since(mark).some(([kind]) => kind === 'built'), 'the later rebuild serves');
open();
await until(() => since(mark).filter(([kind]) => kind === 'release').length === 2, 'the overtaken rebuild releases');
assert.deepEqual(since(mark), [
  ['mint', 'LOADER', 't7'], ['mint', 'CHILD', 't8'],
  ['mint', 'LOADER', 't9'], ['mint', 'CHILD', 't10'], ['commit', 't9', 't10'], ['built'],
  ['release', 't7'], ['release', 't8'],
], 'only the serving build commits; the overtaken one releases its own');

// ── stop() stops the server's owners ─────────────────────────────────────
mark = events.length;
server.stop();
assert.deepEqual(since(mark), [['stop']]);
assert.ok(!events.some(([kind, token]) => kind === 'release' && ['t3', 't4', 't9', 't10'].includes(token)), 'no serving build\'s owner was released by a build');

console.log('ok - wrangler-dev-loader-store (owners minted per binding; committed as the build serves; released when refused or overtaken)');
