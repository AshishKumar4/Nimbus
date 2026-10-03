#!/usr/bin/env bun
// The in-process Vite servers read and write as the command that started them.
//
// `vite` and `vite preview` run in the session, not in a facet, and their
// server read every file it served as the kernel, whoever had run the
// command: a principal who may not read a file had it served to anyone with
// the preview URL. What has to hold, through the real registered `vite`
// command: a server a confined principal started serves what it may read and
// refuses what it may not; `vite build` reads and writes as its caller too;
// and a dev server persisted for a restore records who it ran as.

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

const { EsbuildService } = await import('../../packages/core/src/runtime/esbuild-service.ts');
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
  esbuildService: new EsbuildService(files.namespaceFs(CRED_KERNEL), { engine: esbuildEngine }),
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
