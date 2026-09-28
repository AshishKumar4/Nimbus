#!/usr/bin/env bun
// A hosted runtime serves the SDK's session surface, so an embedder can hand
// a sandbox client to code in another isolate without a second filesystem or
// shell: `Nimbus.fromSession(() => runtime.session(scope))` drives the same
// workspace the embedder holds.
//
// Asserted through composeHostedRuntime and the SDK client:
//   - a session scoped to a shell runs commands only in that named shell, so
//     cwd and exported variables persist, a second shell does not see them,
//     and a client that does not name it is refused, streaming or not;
//   - a file written through the session is the embedder's file, and a
//     command reads it;
//   - a session scoped to an identity acts as that identity for commands and
//     files, and refuses a caller that names another shell or identity; a
//     shell-only scope acts as the session user, never the kernel;
//   - a scope that names no shell runs no command, so it can neither read
//     nor plant the embedder's workspace shell environment, yet reads files;
//   - a scoped session cannot destroy the workspace or manage its
//     applications.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

const root = new URL('../../', import.meta.url).pathname;
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-hosted-session-'));
let bundle;
try {
  const entryPath = join(outputDir, 'entry.ts');
  await writeFile(entryPath, [
    `export { composeHostedRuntime } from '${root}packages/worker/src/workspace-host.ts';`,
    `export { Nimbus } from '${root}packages/sdk/src/sandbox.ts';`,
    `export { NimbusWorkspace } from '${root}packages/core/src/workspace/nimbus-workspace.ts';`,
    `export { SessionProcessSupervisor } from '${root}packages/core/src/runtime/session-process-supervisor.ts';`,
    `export { PortRegistry } from '${root}packages/core/src/runtime/port-registry.ts';`,
    `export { SqliteVFS } from '${root}packages/core/src/vfs/sqlite-vfs.ts';`,
    `export { PID_GEN_STRIDE } from '${root}packages/core/src/runtime/process-table.ts';`,
    `export { CRED_KERNEL, CRED_SESSION_USER } from '${root}packages/core/src/runtime/os-contracts.ts';`,
    `export { composeFabric } from '${root}packages/fabric/src/composition.ts';`,
    '',
  ].join('\n'));
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outputDir, 'out'),
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  bundle = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/entry.js')).path).href);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\//, '');
    return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
  },
};

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const env = {
  WORKSPACES: { idFromName() {}, idFromString() {}, get() {} },
  LOADER: world.loader,
  ASSETS,
};

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: {
    waitUntil: (task) => { facetCtx.waitUntil(task); },
    async schedule() {},
    async cancel() {},
  },
});

const sandbox = (scope) => bundle.Nimbus.fromSession(() => runtime.session(scope)).sandbox('workspace', { shellId: scope.shellId });
const STRANGER = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };

try {
  // ── a scoped shell persists across calls; another shell does not see it ─
  const a = sandbox({ shellId: 'agent-a' });
  const set = await a.exec('cd /tmp && export MARK=seen');
  assert.equal(set.exitCode, 0, set.stderr);
  const kept = await a.exec('pwd; echo "mark=$MARK"');
  assert.equal(kept.stdout.trim(), '/tmp\nmark=seen', 'the named shell kept cwd and the exported variable');
  const other = await sandbox({ shellId: 'agent-b' }).exec('pwd; echo "mark=$MARK"');
  assert.notEqual(other.stdout.trim().split('\n')[0], '/tmp', 'a second shell starts elsewhere');
  assert.equal(other.stdout.trim().split('\n')[1], 'mark=', 'and does not see the first shell\'s variable');
  const unnamed = bundle.Nimbus.fromSession(() => runtime.session({ shellId: 'agent-a' })).sandbox('workspace');
  await assert.rejects(unnamed.exec('pwd'), /EPERM/, 'a client that does not name the scoped shell is refused');
  await assert.rejects(a.execStream('pwd', { shellId: 'agent-b' }), /EPERM/, 'a streaming exec in another shell is refused before it starts');
  console.log('  [1] a session scoped to a shell keeps it; another shell is separate');

  // ── one filesystem: the session's write is the embedder's file ──────────
  await a.files.write('/tmp/shared.txt', 'one plane');
  assert.equal(await runtime.files.readFileString('/tmp/shared.txt'), 'one plane', 'the embedder reads the session\'s write');
  const cat = await a.exec('cat /tmp/shared.txt');
  assert.equal(cat.stdout, 'one plane', 'a command reads it');
  console.log('  [2] files written through the session are the workspace\'s files');

  // ── identity: the scope's credential acts, and cannot be swapped ────────
  const owner = sandbox({ shellId: 'owner', cred: bundle.CRED_SESSION_USER });
  await owner.files.write('/home/user/owned.txt', 'mine');
  const stranger = sandbox({ shellId: 'stranger', cred: STRANGER });
  await assert.rejects(stranger.files.write('/home/user/theirs.txt', 'no'), /EACCES/, 'the stranger cannot write the user\'s home');
  const denied = await stranger.exec('echo no > /home/user/theirs.txt');
  assert.notEqual(denied.exitCode, 0, 'nor can a command it runs');
  assert.equal(await runtime.files.exists('/home/user/theirs.txt'), false);
  await assert.rejects(stranger.files.as(bundle.CRED_SESSION_USER).write('/home/user/theirs.txt', 'no'), /EPERM/, 'a caller cannot name another identity');
  await assert.rejects(stranger.exec('true', { shellId: 'owner' }), /EPERM/, 'nor another shell');
  await assert.rejects(stranger.exec('true', { cred: bundle.CRED_SESSION_USER }), /EPERM/, 'nor run a command as another identity');
  await assert.rejects(a.files.as(STRANGER).read('/tmp/shared.txt'), /EPERM/, 'a shell scope acts as its own identity: it names none');
  await assert.rejects(a.exec('true', { cred: STRANGER }), /EPERM/, 'and runs no command as one');
  // A shell-only scope is the session user for every verb, `files.delete`
  // included, whose own default is the kernel.
  const kernel = runtime.files.as(bundle.CRED_KERNEL);
  await kernel.mkdir('/rootonly', { mode: 0o755 });
  await kernel.writeFile('/rootonly/f', 'kernel');
  await assert.rejects(a.files.delete('/rootonly/f'), /EACCES/, 'a shell-only scope deletes as the session user, not the kernel');
  assert.equal(await runtime.files.exists('/rootonly/f'), true, 'and the kernel\'s file stays');
  console.log('  [3] a session scoped to an identity acts as it and refuses another');

  // ── no shell named, no command: the workspace shell is the embedder's ──
  await runtime.exec('export EMBEDDER_SECRET=s3cr3t');
  const shellless = bundle.Nimbus.fromSession(() => runtime.session({ cred: STRANGER })).sandbox('workspace');
  await assert.rejects(shellless.exec('echo "secret=$EMBEDDER_SECRET"'), /EPERM/, 'a scope with no shell cannot read the embedder\'s shell');
  await assert.rejects(shellless.exec('cd /tmp && export PLANTED=by-stranger'), /EPERM/, 'nor plant in it');
  await assert.rejects(shellless.execStream('true'), /EPERM/, 'streaming or not');
  await assert.rejects(shellless.startProcess('true'), /EPERM/, 'nor start a process');
  await assert.rejects(shellless.exec('true', { shellId: 'agent-a' }), /EPERM/, 'nor enter a named shell');
  assert.equal((await runtime.exec('echo "planted=$PLANTED"')).stdout, 'planted=\n', 'the embedder\'s shell is untouched');
  assert.equal(await shellless.files.read('/tmp/shared.txt'), 'one plane', 'its files still answer');
  console.log('  [4] a scope that names no shell runs no command');

  // ── the embedder owns the workspace's life and its applications ─────────
  await assert.rejects(a.destroy(), /EPERM/, 'a session cannot destroy the workspace');
  assert.equal(await runtime.files.readFileString('/tmp/shared.txt'), 'one plane', 'and the workspace is intact');
  await assert.rejects(a.apps.expose(3000), /EPERM/, 'the application verbs are the embedder\'s');
  await assert.rejects(a.ports.removeDurableApp('anyone'), /EPERM/, 'durable applications too');
  console.log('  [5] a scoped session cannot destroy the workspace or manage its applications');
} finally {
  await runtime.close();
}

console.log('hosted-runtime-session-surface OK');
