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
const { handleFetch } = await import(pathToFileURL(entry.path).href);

const SID = 'nimble-otter-4271';
const BASE_PATH = `/s/${SID}`;
const PREVIEW_BASE = `${BASE_PATH}/preview`;
const VITE_PORT = 5173;
const ROOT = 'home/user/app';

const INDEX_HTML =
  '<!DOCTYPE html><html><head><title>mount app</title>' +
  '<link rel="stylesheet" href="/style.css">' +
  '</head><body><div id="root"></div>' +
  '<script type="module" src="/src/main.js"></script></body></html>';

// A user JS module with a bare import. Its served form must carry the mount
// base on the `/@modules/` URL the browser fetches next.
const DEP_JS = 'import confetti from "canvas-confetti";\nexport default confetti;\n';

function makeVfs() {
  const files = new Map([
    [`${ROOT}/index.html`, INDEX_HTML],
    [`${ROOT}/src/main.js`, 'console.log("main");\n'],
    [`${ROOT}/src/dep.js`, DEP_JS],
    [`${ROOT}/package.json`, JSON.stringify({ name: 'app', dependencies: {} })],
  ]);
  const view = {
    exists: (p) => files.has(p),
    isDirectory: () => false,
    readFileString: (p) => files.get(p),
    readFile: (p) => new TextEncoder().encode(files.get(p) ?? ''),
  };
  return { as: () => view, events: { on: () => () => {} } };
}

function makeWokenSession(storage = {}) {
  const store = new Map(Object.entries(storage));
  let nextPid = 100;
  const self = {
    env: {},
    sqliteFs: null,
    esbuildService: null,
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
      },
    },
    get nimbusDebug() { return false; },
    get viteBasePath() { return (this.sessionBasePath || '') + '/preview'; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = makeVfs(); },
    seedFilesystem() {},
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

await rm(outputDir, { recursive: true, force: true });

console.log('port-route-vite-mount OK: the dev-server mount base follows the door the request came through');
