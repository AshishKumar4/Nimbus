#!/usr/bin/env bun
// Releases before 0.13.2 wrote part of a user's project as root: vite
// build's dist/, npm init's and npm-fast's package.json, and pre-bundling's
// node_modules/.nimbus-synthetic. The tools now act as their caller, so the
// tool that owns each of those hands it to the project's owner before it
// replaces it, and the next build or install succeeds and records its
// change. Before, vite build failed with EACCES on dist/, npm ci failed on
// .nimbus-synthetic, and npm install <pkg> exited 0 without recording the
// package. Only those paths move, and only what the owner could already read
// and replace: a root-only file, or a link, named like one fails the tool,
// and says so. The real NpmInstaller (the fan-out RPC is the seam) and the
// real registered vite command with an in-isolate esbuild.

import assert from 'node:assert/strict';
import { plugin } from 'bun';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = CRED_SESSION_USER;
const PID = 7;
const tgz = (name, version) => `https://registry.invalid/${name}-${version}.tgz`;
const resolved = (name, version) => ({
  pkg: {
    name, version, tarballUrl: tgz(name, version), integrity: 'sha512-fixture',
    dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
  },
  deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
  cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
});

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
const user = vfs.as(USER);
root.mkdir('tmp');
root.chmod('tmp', 0o1777);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', USER.uid, USER.gid);
const files = new ProcessFiles(vfs);

const log = [];
// The shards' batch writes are authorized as the invoking process, so they write as the user.
const env = makeFanoutEnv({ root: user, NM: 'unused', resultFor: (name) => resolved(name, '7.0.0') });
const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
const installer = new NpmInstaller(files, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
const install = (dir, opts = {}) => installer.install(dir, { pid: PID, cred: USER, ...opts });

// ── npm install <pkg> records it in a package.json root wrote ─────────────
{
  user.mkdir('home/user/p');
  root.writeFile('home/user/p/package.json', JSON.stringify({ name: 'p', version: '1.0.0', dependencies: {} }));
  const result = await install('/home/user/p', { packages: ['is-number'] });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(JSON.parse(user.readFileString('home/user/p/package.json')).dependencies, { 'is-number': '^7.0.0' });
  assert.equal(user.stat('home/user/p/package.json').uid, USER.uid, 'package.json is the project owner\'s now');
  console.log('  npm install <pkg> records the package in a package.json an earlier release wrote as root');
}

// ── npm ci clears a node_modules root pre-bundled into ───────────────────
{
  const pkgJson = { name: 'c', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' } };
  user.mkdir('home/user/c/node_modules', { recursive: true });
  user.writeFile('home/user/c/package.json', JSON.stringify(pkgJson));
  user.writeFile('home/user/c/package-lock.json', JSON.stringify({
    name: 'c', lockfileVersion: 3,
    packages: {
      '': pkgJson,
      'node_modules/is-number': { version: '7.0.0', resolved: tgz('is-number', '7.0.0'), integrity: 'sha512-fixture' },
    },
  }));
  root.mkdir('home/user/c/node_modules/.nimbus-synthetic/react', { recursive: true });
  root.writeFile('home/user/c/node_modules/.nimbus-synthetic/react/index.js', 'export {};');
  const result = await install('/home/user/c', { fromLockfile: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.equal(user.exists('home/user/c/node_modules/.nimbus-synthetic'), false, 'the old tree is cleared');
  assert.equal(JSON.parse(user.readFileString('home/user/c/node_modules/is-number/package.json')).version, '7.0.0');
  console.log('  npm ci clears a node_modules an earlier release pre-bundled into as root');
}

// ── only what the owner could already read and replace moves ──────────────
{
  user.mkdir('home/user/s');
  root.writeFile('home/user/s/package.json', JSON.stringify({ name: 's' }), { mode: 0o600 });
  await assert.rejects(install('/home/user/s', { packages: ['is-number'] }), /EACCES/, 'a package.json the install cannot record in fails it');
  assert.equal(root.stat('home/user/s/package.json').uid, 0, 'a root-only file stays root\'s');

  root.mkdir('etc', { recursive: true, mode: 0o755 });
  root.writeFile('etc/shadowed.json', JSON.stringify({ name: 'secret' }));
  user.mkdir('home/user/l');
  user.symlink('/etc/shadowed.json', 'home/user/l/package.json');
  await assert.rejects(install('/home/user/l', { packages: ['is-number'] }), /EACCES/);
  assert.equal(root.stat('etc/shadowed.json').uid, 0, 'a link named package.json is never followed to what it names');
  assert.deepEqual(JSON.parse(root.readFileString('etc/shadowed.json')), { name: 'secret' });
  console.log('  a root-only package.json, or a link named package.json, fails the install and keeps its owner');
}

// ── vite build replaces a dist/ root built ─────────────────────────────────
{
  // esbuild-wasm's module, as the Worker's bundler hands it over.
  const resolveFromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
  const wasmModule = await WebAssembly.compile(await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm')));
  plugin({
    name: 'esbuild-wasm-asset',
    setup(build) {
      build.onLoad({ filter: /esbuild-wasm\/esbuild\.wasm$/ }, () => ({ exports: { default: wasmModule }, loader: 'object' }));
    },
  });
  const { EsbuildService } = await import('../../packages/core/src/runtime/esbuild-service.ts');
  // vite-command.ts transitively imports `cloudflare:workers`; bundled with the stub the route tests use.
  const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-root-artifacts-test-'));
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
  const registry = new CommandRegistry();
  registry.register('vite', createViteCommand({
    ensureSqliteFs() {},
    getFilesystemAuthority() { return files; },
    ensureBundlePool() { return null; },
    sqliteFs: vfs,
    esbuildService: new EsbuildService(files.namespaceFs(CRED_KERNEL)),
  }));

  user.mkdir('home/user/v');
  user.writeFile('home/user/v/index.html', '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  user.writeFile('home/user/v/main.js', 'document.body.textContent = "hi";\n');
  root.mkdir('home/user/v/dist/assets', { recursive: true });
  root.writeFile('home/user/v/dist/assets/old.js', 'old');
  let stderr = '';
  const code = await (await registry.resolve('vite'))({
    args: ['build'], cwd: '/home/user/v', env: {}, pid: PID, cred: USER, vfs: files.view({ pid: PID, cred: USER }),
    stdout: { write() {} },
    stderr: { write: (s) => { stderr += s; } },
  });
  assert.equal(code, 0, stderr);
  assert.equal(user.exists('home/user/v/dist/assets/old.js'), false, 'the old build is cleared');
  assert.match(user.readFileString('home/user/v/dist/index.html'), /assets\/main-[A-Z0-9]+\.js/);
  assert.equal(user.stat('home/user/v/dist').uid, USER.uid);
  console.log('  vite build replaces a dist/ an earlier release built as root');
}

await harness.close?.();
console.log('root-owned-tool-artifacts: ok');
