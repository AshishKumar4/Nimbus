#!/usr/bin/env bun
// The in-process Vite servers read and write as the command that started them.
//
// `vite` and `vite preview` run in the session, not in a facet, and their
// server read every file it served as the kernel, whoever had run the
// command: a principal who may not read a file had it served to anyone with
// the preview URL. What has to hold, through the real registered `vite`
// command: a server a confined principal started serves what it may read and
// refuses what it may not, including a module bundle another principal's
// server left in the workspace's shared module cache, and a package it may
// not enter (403, not a rejected handler); `vite build` reads and writes as
// its caller too; a dev server persisted for a restore records who it ran
// as; and real-vite finds and bundles the user's vite.config as the caller.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createRequire } from 'node:module';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';

const AGENT = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };
const SECRET = 'only the session user may read this';

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
const user = vfs.as(CRED_SESSION_USER);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);

// A project the agent may read but not change, holding one file only the
// session user may read, and a build the session user made.
user.mkdir('home/user/v/dist', { recursive: true });
user.mkdir('home/user/v/node_modules');
user.writeFile('home/user/v/index.html', '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
user.writeFile('home/user/v/main.js', 'document.body.textContent = "hi";\n');
user.writeFile('home/user/v/secret.txt', SECRET, { mode: 0o600 });
user.writeFile('home/user/v/dist/index.html', '<!doctype html><title>built</title>');
user.writeFile('home/user/v/dist/secret.txt', SECRET, { mode: 0o600 });
// A package with a module only the session user may read, and a package
// only the session user may enter.
user.mkdir('home/user/v/node_modules/pkg', { recursive: true });
user.writeFile('home/user/v/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }));
user.writeFile('home/user/v/node_modules/pkg/index.js', 'export default 1;\n');
user.writeFile('home/user/v/node_modules/pkg/private.js', `export default ${JSON.stringify(SECRET)};\n`, { mode: 0o600 });
user.mkdir('home/user/v/node_modules/closed', { mode: 0o700 });
user.writeFile('home/user/v/node_modules/closed/package.json', JSON.stringify({ name: 'closed', version: '1.0.0', main: 'index.js' }));
user.writeFile('home/user/v/node_modules/closed/index.js', 'export default 2;\n');
// A real-vite project whose config imports a file only the session user may read.
user.mkdir('home/user/rv', { recursive: true });
user.writeFile('home/user/rv/secret.js', `export default ${JSON.stringify(SECRET)};\n`, { mode: 0o600 });
user.writeFile('home/user/rv/vite.config.js', "import secret from './secret.js';\nexport default { define: { SECRET: JSON.stringify(secret) } };\n");

// vite-command.ts transitively imports `cloudflare:workers`; bundled with the stub the route tests use.
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-vite-principal-'));
let createViteCommand;
try {
  const bundle = await Bun.build({
    entrypoints: ['./packages/worker/src/session/vite-command.ts'],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(bundle.success, true, bundle.logs.map(String).join('\n'));
  ({ createViteCommand } = await import(pathToFileURL(bundle.outputs.find((o) => o.path.endsWith('/vite-command.js')).path).href));
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

// start-real-vite.ts with its facet stubbed: what it hands CirrusReal is what is observed.
const realViteDir = await mkdtemp(join(tmpdir(), 'nimbus-vite-principal-real-'));
let startRealVite;
try {
  const entryPath = join(realViteDir, 'entry.ts');
  await Bun.write(entryPath, `export { startRealVite } from '${new URL('../../packages/worker/src/session/start-real-vite.ts', import.meta.url).pathname}';\n`);
  const bundle = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(realViteDir, 'out'),
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cirrus-real-test-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
        builder.onResolve({ filter: /facets\/cirrus-real\.js$/ }, () => ({ path: 'cirrus', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          loader: 'js',
          contents: args.path === 'cf'
            ? 'export class DurableObject {}; export class WorkerEntrypoint {};'
            : `export function shouldUseRealVite() { return true; }
               export class CirrusReal {
                 constructor(opts) { globalThis.__cirrusRealOpts = opts; this._running = false; }
                 get isRunning() { return this._running; }
                 async start() { this._running = true; }
                 stop() { this._running = false; }
                 async handleRequest() { return new Response('real-vite'); }
                 get stats() { return { snapshot: null, viteVersion: 'test' }; }
               }`,
        }));
      },
    }],
  });
  assert.equal(bundle.success, true, bundle.logs.map(String).join('\n'));
  ({ startRealVite } = await import(pathToFileURL(bundle.outputs.find((o) => o.path.endsWith('/entry.js')).path).href));
} finally {
  await rm(realViteDir, { recursive: true, force: true });
}

const { EsbuildService } = await import('../../packages/core/src/runtime/esbuild-service.ts');
const { prebundleCacheKey, prebundleRequest } = await import('../../packages/worker/src/npm/cache-keys.ts');
const { buildWithRolldown } = await import('../../packages/core/src/runtime/rolldown-build.ts');
const { NpmCache } = await import('../../packages/worker/src/npm/cache.ts');
const rolldown = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));
const processes = new SessionProcessSupervisor();
const stored = new Map();
const storage = {
  sql: harness.sql,
  get: async (key) => stored.get(key),
  put: async (key, value) => { stored.set(key, structuredClone(value)); },
  delete: async (key) => stored.delete(key),
  transaction: async (body) => body({
    get: async (key) => stored.get(key),
    put: async (key, value) => { stored.set(key, structuredClone(value)); },
    delete: async (key) => stored.delete(key),
  }),
};
const host = {
  ensureSqliteFs() {},
  getFilesystemAuthority() { return files; },
  ensureBundlePool() { return null; },
  ensureFacetManager() {},
  facetManager: null,
  sqliteFs: vfs,
  // The session's service as production builds it (supervisorEsbuildService):
  // esbuild transforms, rolldown bundles (rolldownBuildHost, here over the
  // native binding rather than the build facet).
  esbuildService: new EsbuildService(files.namespaceFs(CRED_KERNEL), {
    engine: esbuildEngine,
    buildHost: async (options, plugin) => structuredClone(await buildWithRolldown(rolldown, structuredClone(options), plugin)),
  }),
  processes,
  ctx: { storage, waitUntil() {} },
  env: {},
  viteBasePath: '/preview',
  viteDevServer: null,
  terminal: null,
  portRegistry: { bindFacetStub() {}, register() {}, unregister() {}, has: () => false, getAll: () => [] },
};
const registry = new CommandRegistry();
registry.register('vite', createViteCommand(host));

async function vite(args, cred) {
  const { pid } = processes.spawn('sh', ['sh'], '/home/user/v', { cred });
  let stderr = '';
  const code = await (await registry.resolve('vite'))({
    args, cwd: '/home/user/v', env: {}, pid, cred, vfs: files.view({ pid, cred }),
    stdout: { write() {} },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stderr };
}

async function served(path) {
  const response = await host.viteDevServer.handleRequest(new Request(`https://session.test/preview${path}`), path);
  return { status: response.status, body: await response.text() };
}

try {
  // ── vite preview, by the agent ──────────────────────────────────────────
  {
    const { code, stderr } = await vite(['preview'], AGENT);
    assert.equal(code, 0, stderr);
    assert.equal((await served('/index.html')).status, 200, 'the build is served');
    const secret = await served('/secret.txt');
    assert.notEqual(secret.body, SECRET, `preview serves no file its principal may not read (status ${secret.status})`);
    host.viteDevServer.stop();
  }

  // ── vite (the dev server), by the agent ──────────────────────────────────
  {
    const { code, stderr } = await vite(['--force'], AGENT);
    assert.equal(code, 0, stderr);
    assert.match((await served('/main.js')).body, /textContent/, 'the project is served');
    const secret = await served('/secret.txt');
    assert.notEqual(secret.body, SECRET, `the dev server serves no file its principal may not read (status ${secret.status})`);
    assert.deepEqual(stored.get('vite-config')?.identity?.cred, AGENT, 'and what a restore reads records who it ran as');
    host.viteDevServer.stop();
  }

  // ── vite build, by the agent: no write where the agent may not ──────────
  {
    const before = user.readFileString('home/user/v/dist/index.html');
    const { code } = await vite(['build'], AGENT);
    assert.notEqual(code, 0, 'the agent may not replace the session user\'s build');
    assert.equal(user.readFileString('home/user/v/dist/index.html'), before, 'which is left as it was');
  }

  // ── a cached bundle that says nothing of what it was built from ─────────
  {
    const own = await vite(['--force'], CRED_SESSION_USER);
    assert.equal(own.code, 0, own.stderr);
    // As a writer that recorded no provenance left it (sources []), with the current build's key.
    new NpmCache(harness.sql).putEsmBundle({
      specifier: 'pkg', bundleHash: await prebundleCacheKey(prebundleRequest('pkg', [])), esmCode: "export default 'from-unknown-provenance';",
      builtAt: Date.now(), inputHash: '', sources: [],
    });
    const module = await served('/@modules/pkg');
    assert.equal(module.status, 200, module.body);
    assert.equal(module.body.includes('from-unknown-provenance'), false, 'a bundle with no recorded sources is never served: it is rebuilt');
    host.viteDevServer.stop();
  }

  // ── the shared module cache, and a package the agent may not enter ──────
  {
    const own = await vite(['--force'], CRED_SESSION_USER);
    assert.equal(own.code, 0, own.stderr);
    const built = await served('/@modules/pkg/private');
    assert.equal(built.status, 200, built.body);
    assert.ok(built.body.includes(SECRET), 'the session user\'s server bundles its own module');
    host.viteDevServer.stop();

    const theirs = await vite(['--force'], AGENT);
    assert.equal(theirs.code, 0, theirs.stderr);
    const cached = await served('/@modules/pkg/private');
    assert.equal(cached.body.includes(SECRET), false,
      `the agent's server is not handed the bundle the cache holds (status ${cached.status})`);
    assert.equal(cached.status, 403);
    const closed = await served('/@modules/closed');
    assert.equal(closed.status, 403, 'a package the agent may not enter is forbidden');
    host.viteDevServer.stop();
  }

  // ── real-vite finds and bundles the config as the caller ─────────────────
  {
    const realVite = async (cred) => {
      let configError = null;
      globalThis.__cirrusRealOpts = null;
      await startRealVite(host, {
        root: 'home/user/rv', port: 5190, basePath: '/preview', configDir: 'home/user/rv',
        identity: { cwd: '/home/user/rv', argv: ['vite'], cred },
        onConfigError: (message) => { configError = message; },
      });
      host.cirrusReal.stop();
      return { bundle: globalThis.__cirrusRealOpts?.userConfigBundle ?? null, configError };
    };
    const own = await realVite(CRED_SESSION_USER);
    assert.ok(own.bundle?.includes(SECRET), `the session user's config is bundled with what it imports: ${own.configError}`);
    const theirs = await realVite(AGENT);
    assert.equal(theirs.bundle?.includes(SECRET) ?? false, false, 'the agent\'s config is not bundled with a file the agent may not read');
    assert.match(String(theirs.configError), /EACCES|permission|denied/i, `and says why: ${theirs.configError}`);
  }

  // ── the session user's server still serves the session user's files ─────
  {
    const { code, stderr } = await vite(['preview'], CRED_SESSION_USER);
    assert.equal(code, 0, stderr);
    assert.equal((await served('/secret.txt')).body, SECRET);
    host.viteDevServer.stop();
  }
} finally {
  await stopEsbuildEngine();
}

console.log('ok - vite-principal-credential (the in-process vite servers read as the command that started them)');
