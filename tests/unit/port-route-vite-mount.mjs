#!/usr/bin/env bun
// port-route-vite-mount — the dev server's mount base is per-request, not baked
// at construction.
//
// A `ViteDevServer` answers three doors: the `/s/<sid>/preview/` path, the
// `/s/<sid>/port/<n>/` path, and the root of a `<port>--<sid>` preview host
// (which the router forwards as `/port/<n>/` with an empty base header). The
// served base — `<base href>`, absolute-path rewrites, and the module URLs the
// browser fetches next — must match the door the request came through. Baking
// one base for all three made every asset on the host resolve under
// `/s/<sid>/preview/`, which does not exist there → 404. Driven through
// `handleFetch`, the DO's public entrypoint.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-port-mount-test-'));
const build = await Bun.build({
  entrypoints: ['./packages/worker/src/session/routes.ts'],
  outdir: outputDir,
  target: 'bun',
  format: 'esm',
  plugins: [{
    name: 'cloudflare-workers-test-stub',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
        path: 'cloudflare-workers',
        namespace: 'test',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
        loader: 'js',
      }));
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const entry = build.outputs.find((output) => output.path.endsWith('/routes.js'));
assert.ok(entry, 'the routes bundle was emitted');
const { handleFetch, restorePersistedDevServer: sessionRestorePersistedDevServer } = await import(pathToFileURL(entry.path).href);

const SID = 'nimble-otter-4271';
const BASE_PATH = `/s/${SID}`;
const PREVIEW_BASE = `${BASE_PATH}/preview`;
const VITE_PORT = 5173;
const ROOT = 'home/user/example-app';

const INDEX_HTML =
  '<!DOCTYPE html><html><head><title>mount app</title>' +
  '<link rel="stylesheet" href="/style.css">' +
  '</head><body><div id="root"></div>' +
  '<script type="module" src="/src/main.js"></script></body></html>';

// A user JS module with a bare import. Its served form must carry the mount
// base on the `/@modules/` URL the browser fetches next.
const DEP_JS = 'import confetti from "canvas-confetti";\nexport default confetti;\n';

/**
 * A stub VFS over an in-memory file map. Every parent of a file is a
 * directory, so the package walkers (`readdir`, `isDirectory`) see the same
 * shape SqliteVFS gives them.
 *
 *   `faults` maps a path to how many times `exists(path)` should throw
 *   before answering normally — the one fault the cold module path can be
 *   handed from inside its coalesced attempt (package resolution walks
 *   `home/user/node_modules`, which nothing before it touches).
 *   `extraFiles` adds fixture files (string or Uint8Array bodies).
 *   `reads` receives every `readFile` path, in order, when given.
 */
function makeVfs({ faults = new Map(), extraFiles = new Map(), reads = null } = {}) {
  const files = new Map([
    [`${ROOT}/index.html`, INDEX_HTML],
    [`${ROOT}/src/main.js`, 'console.log("main");\n'],
    [`${ROOT}/src/dep.js`, DEP_JS],
    [`${ROOT}/package.json`, JSON.stringify({ name: 'app', dependencies: {} })],
    ...extraFiles,
  ]);
  const dirs = new Set();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const encoder = new TextEncoder();
  const view = {
    exists: (p) => {
      const remaining = faults.get(p) ?? 0;
      if (remaining > 0) {
        faults.set(p, remaining - 1);
        throw new Error(`injected vfs fault: ${p}`);
      }
      return files.has(p) || dirs.has(p);
    },
    isDirectory: (p) => dirs.has(p),
    readdir: (dir) => {
      if (!dirs.has(dir)) throw new Error(`ENOENT: ${dir}`);
      const names = new Map();
      for (const path of [...files.keys(), ...dirs]) {
        if (!path.startsWith(dir + '/')) continue;
        const name = path.slice(dir.length + 1).split('/')[0];
        names.set(name, dirs.has(dir + '/' + name) ? 'directory' : 'file');
      }
      return [...names].map(([name, type]) => ({ name, type }));
    },
    readFileString: (p) => {
      const body = files.get(p);
      return body instanceof Uint8Array ? new TextDecoder().decode(body) : body;
    },
    readFile: (p) => {
      reads?.push(p);
      const body = files.get(p);
      return body instanceof Uint8Array ? body : encoder.encode(body ?? '');
    },
  };
  return { as: () => view, events: { on: () => () => {} } };
}

/**
 * A bundle pool whose facet never runs: every submit is parked until the
 * test settles it, so the supervisor side of a cold build can be held at
 * the exact point where its slice is resident.
 */
function makeParkedBundlePool() {
  const submits = [];
  const pool = {
    submit: (_fn, spec) => new Promise((resolve, reject) => {
      submits.push({ specifier: spec.specifier, sliceBytes: spec.slice.reduce((n, e) => n + (e.bytes?.length ?? 0), 0), resolve, reject });
    }),
  };
  return { provider: { acquire: async () => pool }, submits };
}

function makeWokenSession(storage = {}, { faults, extraFiles, reads, bundlePool = null } = {}) {
  const store = new Map(Object.entries(storage));
  let nextPid = 100;
  const self = {
    env: {},
    sqliteFs: null,
    esbuildService: null,
    bundlePool,
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    portRegistry: new PortRegistry(),
    processes: {
      spawn: () => ({ pid: nextPid++ }),
      appendOutput: () => {},
    },
    ctx: {
      storage: {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
        // The reservation paths run read-modify-write inside one unit; the
        // stub serializes them the way the DO storage does.
        async transaction(body) { return body(this); },
      },
    },
    get nimbusDebug() { return false; },
    get viteBasePath() { return (this.sessionBasePath || '') + '/preview'; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = makeVfs({ faults, extraFiles, reads }); },
    ensureBundlePool() { return this.bundlePool; },
    restorePersistedDevServer: (onlyPort) => sessionRestorePersistedDevServer(self, onlyPort),
  };
  self.store = store;
  return self;
}

const HIBERNATED = {
  'vite-config': { root: ROOT, basePath: PREVIEW_BASE, port: VITE_PORT },
};

// A request through the `<port>--<sid>` host: the router forwards it as
// `/port/<n>/…` with the base header set to '' (mounted at the origin root).
function hostRequest(path) {
  return new Request(`https://nimbus-os.dev${path}`, {
    headers: { 'X-Nimbus-Base': '' },
  });
}

// A request through a `/s/<sid>/…` path: the base header carries `/s/<sid>`.
function pathRequest(path) {
  return new Request(`https://nimbus-os.dev${path}`, {
    headers: { 'X-Nimbus-Base': BASE_PATH },
  });
}

// 1. The `<port>--<sid>` host serves at the root: NO <base href>, and nothing
//    references the non-existent `/s/<sid>/preview/` prefix. This is the exact
//    defect — a baked base put `<base href="/s/<sid>/preview/">` here and 404'd
//    every asset.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/`));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /mount app/);
  assert.doesNotMatch(html, /<base /, 'a root-mounted host must not inject a <base> tag');
  assert.doesNotMatch(html, new RegExp(PREVIEW_BASE), 'no asset URL may carry the preview-path prefix on the host');
  // The absolute asset refs stay root-relative, resolvable at the host root.
  assert.match(html, /href="\/style\.css"/);
  assert.match(html, /src="\/src\/main\.js"/);
  console.log('  [1] `<port>--<sid>` host serves at the root — no <base>, no /preview/ prefix');
}

// 2. The `/preview/` path still serves under `/s/<sid>/preview/` — the base tag
//    and every absolute path rewrite are present. Pinned so the shared path
//    can't lose the path-route behaviour.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, pathRequest('/preview/'));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(`<base href="${PREVIEW_BASE}/">`), 'the preview path must inject its base');
  assert.match(html, new RegExp(`href="${PREVIEW_BASE}/style\\.css"`), 'absolute asset paths are prefixed');
  assert.match(html, new RegExp(`src="${PREVIEW_BASE}/src/main\\.js"`));
  console.log('  [2] `/preview/` path keeps its `/s/<sid>/preview/` base');
}

// 3. The `/s/<sid>/port/<n>/` path form mounts under `/s/<sid>/port/<n>` — the
//    base is derived from the door, so this third form gets its own base too.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, pathRequest(`/port/${VITE_PORT}/`));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(`<base href="${BASE_PATH}/port/${VITE_PORT}/">`), 'the port path form mounts under /port/<n>');
  console.log('  [3] `/s/<sid>/port/<n>/` path form mounts under its own base');
}

// 4. Module URLs the browser fetches next carry the request's base. A bare
//    `import "canvas-confetti"` becomes `<base>/@modules/canvas-confetti`, and
//    the SAME session serving the SAME file to two doors must not hand one
//    door the other's cached, wrong-base transform.
{
  const self = makeWokenSession(HIBERNATED);

  const onHost = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/src/dep.js`));
  assert.equal(onHost.status, 200);
  const hostCode = await onHost.text();
  assert.match(hostCode, /["']\/@modules\/canvas-confetti["']/, 'host module URL is root-relative');
  assert.doesNotMatch(hostCode, new RegExp(PREVIEW_BASE), 'host module URL must not carry the preview prefix');

  // Same file, same live session, now via the preview path. If the module
  // cache were not keyed by base, this would return the host transform.
  const onPath = await handleFetch(self, pathRequest('/preview/src/dep.js'));
  assert.equal(onPath.status, 200);
  const pathCode = await onPath.text();
  assert.match(pathCode, new RegExp(`["']${PREVIEW_BASE}/@modules/canvas-confetti["']`), 'path module URL carries the preview prefix');
  console.log('  [4] module URLs are per-base and the transform cache is keyed by base');
}

// 5. Simultaneous identical /@modules/ requests coalesce into ONE cold build,
//    and every requester still reads the full body. A Response body is
//    readable once; handing the same Response object to two doors made the
//    second reader fail with a consumed body. Both consumers here must read
//    the same complete bytes independently.
{
  const self = makeWokenSession(HIBERNATED);
  const path = `/port/${VITE_PORT}/@modules/canvas-confetti`;
  const [first, second, third] = await Promise.all([
    handleFetch(self, hostRequest(path)),
    handleFetch(self, hostRequest(path)),
    handleFetch(self, hostRequest(path)),
  ]);
  assert.notEqual(first, second, 'coalesced consumers must not share one Response object');
  assert.notEqual(second, third);
  for (const response of [first, second, third]) {
    assert.equal(response.status, 200);
    assert.equal(response.bodyUsed, false, 'no consumer starts with a consumed body');
  }
  // Read the initiator LAST so the order of consumption cannot mask a shared
  // body: the later requesters must not depend on the first being unread.
  const thirdText = await third.text();
  const secondText = await second.text();
  const firstText = await first.text();
  assert.match(firstText, /__nimbus_optional_dep_stub = true/, 'the cold path served the not-installed stub');
  assert.equal(secondText, firstText, 'second consumer reads the same full bytes');
  assert.equal(thirdText, firstText, 'third consumer reads the same full bytes');
  assert.equal(first.headers.get('Content-Type'), 'application/javascript; charset=utf-8');
  assert.equal(second.headers.get('Content-Type'), first.headers.get('Content-Type'));
  // A later request lands on the hot cache with an independent body too.
  const later = await handleFetch(self, hostRequest(path));
  assert.equal(await later.text(), firstText);
  console.log('  [5] coalesced identical requests each read the full module body');
}

// 6. A cold build that throws rejects every coalesced requester with THAT
//    failure — and does not pin the failure: the next request for the same
//    module re-enters the cold path instead of inheriting a settled rejection.
{
  const faults = new Map([['home/user/node_modules/boom-pkg', 1]]);
  const self = makeWokenSession(HIBERNATED, { faults });
  const path = `/port/${VITE_PORT}/@modules/boom-pkg`;
  const attempts = [
    handleFetch(self, hostRequest(path)),
    handleFetch(self, hostRequest(path)),
  ];
  const outcomes = await Promise.allSettled(attempts);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected', 'every coalesced requester sees the cold-path failure');
    assert.match(String(outcome.reason?.message ?? outcome.reason), /injected vfs fault: home\/user\/node_modules\/boom-pkg/);
  }
  assert.equal(faults.get('home/user/node_modules/boom-pkg'), 0, 'exactly one cold attempt consumed the single fault');
  const retry = await handleFetch(self, hostRequest(path));
  assert.equal(retry.status, 200, 'a rejected cold build must not poison the next request');
  assert.match(await retry.text(), /__nimbus_optional_dep_stub = true/);
  console.log('  [6] a rejected cold build is shared by its waiters and cleared for the next request');
}

// 7. Two cold builds for DIFFERENT modules never hold their slices at the
//    same time when together they exceed the supervisor allocation budget.
//    The lease is taken before the slice is built, so the second build's
//    package files are not even read while the first build's facet RPC is
//    outstanding; they are read only after the first Response exists.
{
  const MiB = 1024 * 1024;
  const bigBody = new Uint8Array(20 * MiB);
  const reads = [];
  const timeline = [];
  const { provider, submits } = makeParkedBundlePool();
  const extraFiles = new Map([
    [`${ROOT}/node_modules/big-pkg/package.json`, JSON.stringify({ name: 'big-pkg', main: 'index.js' })],
    [`${ROOT}/node_modules/big-pkg/index.js`, bigBody],
    [`${ROOT}/node_modules/small-pkg/package.json`, JSON.stringify({ name: 'small-pkg', main: 'index.js' })],
    [`${ROOT}/node_modules/small-pkg/index.js`, 'module.exports = "small";\n'],
  ]);
  const self = makeWokenSession(HIBERNATED, { extraFiles, reads, bundlePool: provider });
  const smallEntry = `${ROOT}/node_modules/small-pkg/index.js`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const until = async (predicate, what) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const big = handleFetch(self, hostRequest(`/port/${VITE_PORT}/@modules/big-pkg`))
    .then((response) => { timeline.push('big:response'); return response; });
  await until(() => submits.length === 1, 'the big build to reach its facet submit');
  assert.equal(submits[0].specifier, 'big-pkg');
  assert.ok(submits[0].sliceBytes >= bigBody.byteLength, 'the big slice (entry + package.json) is resident at the submit');

  const small = handleFetch(self, hostRequest(`/port/${VITE_PORT}/@modules/small-pkg`))
    .then((response) => { timeline.push('small:response'); return response; });
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(submits.length, 1, 'the small build must not reach the facet while the big slice is held');
  assert.ok(!reads.includes(smallEntry), 'the small slice must not be built while the big slice is held');

  submits[0].resolve({ ok: true, esmCode: 'export default "big";' });
  const bigResponse = await big;
  assert.equal(bigResponse.status, 200);
  assert.match(await bigResponse.text(), /"big"/);

  await until(() => submits.length === 2, 'the small build to reach its facet submit after the big one released');
  assert.equal(submits[1].specifier, 'small-pkg');
  assert.ok(reads.includes(smallEntry), 'the small slice is built once the budget frees');
  assert.deepEqual(timeline, ['big:response'], 'the small build started only after the big Response existed');

  submits[1].resolve({ ok: true, esmCode: 'export default "small";' });
  const smallResponse = await small;
  assert.equal(smallResponse.status, 200);
  assert.match(await smallResponse.text(), /"small"/);
  assert.deepEqual(timeline, ['big:response', 'small:response']);
  console.log('  [7] two cold builds never hold slices beside each other under the supervisor budget');
}

await rm(outputDir, { recursive: true, force: true });

console.log('port-route-vite-mount OK: the dev-server mount base follows the door the request came through');
