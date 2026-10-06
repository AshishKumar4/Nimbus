#!/usr/bin/env bun
// `vite build` of a project on an asynchronous mount (no `sync` face, every
// call awaited) builds it there, as it does in the SQLite home: index.html,
// the entry and every module esbuild asks for are read through the command's
// view of the namespace, and dist/ is written back through it. Before, the
// command read the project from the engine ("Warning: no index.html", then
// "no entry point"), and the session's esbuild service read modules through a
// synchronous face a mount without one refuses. The real registered command
// and a real in-isolate esbuild; nothing of the mounted build lands in SQLite,
// and a mount's link into SQLite builds the project it names, there.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { asyncMemoryVfs } from './lib/async-memory-vfs.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { EsbuildService } = await import('../../packages/core/src/runtime/esbuild-service.ts');

// vite-command.ts transitively imports `cloudflare:workers`; bundled with the stub the route tests use.
const { createViteCommand } = await importWorkerBundle({ 'packages/worker/src/session/vite-command.ts': ['createViteCommand'] });

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);
files.vfs.mount('/m', asyncMemoryVfs());
const view = files.view({ pid: 7, cred: CRED_SESSION_USER });

const registry = new CommandRegistry();
registry.register('vite', createViteCommand({
  ensureSqliteFs() {},
  getFilesystemAuthority() { return files; },
  ensureBundlePool() { return null; },
  sqliteFs: vfs,
  // The session's own service: the kernel's synchronous view, which a mount without a sync face refuses.
  esbuildService: new EsbuildService(files.namespaceFs(CRED_KERNEL), { engine: esbuildEngine }),
}));

/** Kinu's project (index.html naming main.js) at `dir`, then `vite build` there. */
async function build(dir) {
  if (!await view.exists(dir)) await view.mkdir(dir, { recursive: true });
  await view.writeFile(`${dir}/index.html`, '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  await view.writeFile(`${dir}/main.js`, 'import { text } from "./text.js";\ndocument.body.textContent = text;\n');
  await view.writeFile(`${dir}/text.js`, 'export const text = "hi";\n');
  let stdout = '';
  let stderr = '';
  const code = await (await registry.resolve('vite'))({
    args: ['build'], cwd: dir, env: {}, pid: 7, cred: CRED_SESSION_USER, vfs: view,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  // The entry's hash names its bytes, which carry the project's path.
  return { code, stdout: stdout.replace(/built in [\d.]+s/, 'built in <t>s').replace(/main-[A-Z0-9]+\.js/, 'main-<hash>.js'), stderr };
}

const home = await build('/home/user/v');
assert.equal(home.code, 0, home.stderr);
const mount = await build('/m/v');
assert.equal(mount.code, 0, mount.stderr);
assert.equal(mount.stdout.replaceAll('m/v/', 'home/user/v/'), home.stdout, 'the mounted build prints what the home build prints');
assert.equal(mount.stderr, home.stderr);

const html = await view.readFileString('/m/v/dist/index.html');
const asset = html.match(/assets\/main-[A-Z0-9]+\.js/)?.[0];
assert.ok(asset, html);
assert.match(await view.readFileString(`/m/v/dist/${asset}`), /"hi"/, 'the bundle holds the module read from the mount');
assert.equal(root.exists('m'), false, 'nothing of the mounted build in SQLite');

// A mount's link into SQLite builds the project it names, in place there.
await view.mkdir('/home/user/lv', { recursive: true });
await view.symlink('/home/user/lv', '/m/lv');
const linked = await build('/m/lv');
assert.equal(linked.code, 0, linked.stderr);
assert.equal(linked.stdout.replaceAll('m/lv/', 'home/user/v/'), home.stdout);
assert.match(vfs.as(CRED_SESSION_USER).readFileString('home/user/lv/dist/index.html'), /assets\/main-[A-Z0-9]+\.js/);
await stopEsbuildEngine();
console.log('vite-build-async-mount: ok');
