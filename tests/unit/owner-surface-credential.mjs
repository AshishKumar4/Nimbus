#!/usr/bin/env bun
// The session's owner surfaces act as the session's user, never as the
// kernel: the editor pane, the agent's file tools, /api/write-file and
// /api/mkdir, and the SDK's files.delete unless the embedder asks for the
// kernel by name. Each refuses what the user's own shell is refused: a
// kernel-owned 0644 file, another uid's 0600 file and 0700 directory, a
// kernel-owned directory, and a file the kernel provisioned in a sticky
// directory. Red before: each acted as CRED_KERNEL, so a browser save, an
// agent tool call or an HTTP write replaced a protected file (the class of
// audit SES-6).

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const {
  CRED_KERNEL, CRED_SESSION_USER, ProcessFiles, SessionProcessSupervisor, SqliteVFS,
  editorViews, serveEditorFs, runTool, handleFetch, rpcDeleteFile,
} = await importWorkerBundle({
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL', 'CRED_SESSION_USER'],
  'packages/core/src/runtime/process-files.ts': ['ProcessFiles'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/worker/src/session/editor-fs.ts': ['editorViews', 'serveEditorFs'],
  'packages/worker/src/session/agent.ts': ['runTool'],
  'packages/worker/src/session/routes.ts': ['handleFetch'],
  'packages/worker/src/session/programmatic.ts': ['rpcDeleteFile'],
});

const OTHER = { uid: 1001, gid: 1001 };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
const user = (path) => kernel.chown(path, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
user('home/user');
kernel.writeFile('home/user/protected.txt', 'kept', { mode: 0o644 });
kernel.mkdir('home/user/locked', { mode: 0o755 });
kernel.mkdir('home/user/private', { mode: 0o700 });
kernel.chown('home/user/private', OTHER.uid, OTHER.gid);
kernel.writeFile('home/user/private/secret.txt', 'theirs', { mode: 0o600 });
kernel.chown('home/user/private/secret.txt', OTHER.uid, OTHER.gid);
kernel.mkdir('home/user/sticky', { mode: 0o1777 });
kernel.writeFile('home/user/sticky/provisioned.txt', 'provisioned', { mode: 0o644 });
const namespace = new ProcessFiles(engine);
const processes = new SessionProcessSupervisor();
const text = (path) => kernel.readFileString(path);
const ownedByUser = (path) => kernel.stat(path).uid === CRED_SESSION_USER.uid;
const denied = /EACCES|EPERM/;

// ── the editor pane ─────────────────────────────────────────────────────────
{
  const views = editorViews(namespace, CRED_SESSION_USER);
  const save = await serveEditorFs(views, { type: 'fs-write', path: '/home/user/protected.txt', content: 'replaced' });
  assert.equal(save.ok, false, `the editor saved over a kernel-owned file: ${JSON.stringify(save)}`);
  assert.match(save.error, denied);
  assert.equal(text('home/user/protected.txt'), 'kept');
  const read = await serveEditorFs(views, { type: 'fs-read', path: '/home/user/private/secret.txt' });
  assert.match(String(read.error), denied, `the editor read another uid's 0600 file: ${JSON.stringify(read)}`);
  // The tree skips a directory it cannot read, as it always has: it shows nothing in it.
  const list = await serveEditorFs(views, { type: 'fs-list', dir: '/home/user/private' });
  assert.deepEqual(list.entries ?? [], [], `the editor listed another uid's 0700 directory: ${JSON.stringify(list)}`);
  const tree = await serveEditorFs(views, { type: 'fs-list', dir: '/home/user', recursive: true });
  assert.ok(!tree.entries.some((entry) => entry.path.startsWith('/home/user/private/')), `the editor's tree shows another uid's files: ${JSON.stringify(tree.entries)}`);
  const own = await serveEditorFs(views, { type: 'fs-write', path: '/home/user/notes/editor.txt', content: 'mine' });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.ok(ownedByUser('home/user/notes/editor.txt'), 'what the editor saves belongs to the user');
  console.log('  the editor acts as the session user');
}

// ── the agent's file tools ──────────────────────────────────────────────────
{
  const host = { sqliteFs: engine, processes, getFilesystemAuthority: () => namespace, async ensureRuntimeReady() {} };
  const write = await runTool(host, 'write_file', { path: '/home/user/protected.txt', content: 'replaced' });
  assert.match(String(write.error), denied, `the agent wrote over a kernel-owned file: ${JSON.stringify(write)}`);
  assert.equal(text('home/user/protected.txt'), 'kept');
  const read = await runTool(host, 'read_file', { path: '/home/user/private/secret.txt' });
  assert.match(String(read.error), denied, `the agent read another uid's 0600 file: ${JSON.stringify(read)}`);
  const list = await runTool(host, 'list_files', { path: '/home/user/private' });
  assert.match(String(list.error), denied, `the agent listed another uid's 0700 directory: ${JSON.stringify(list)}`);
  const own = await runTool(host, 'write_file', { path: '/home/user/notes/agent.txt', content: 'mine' });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.ok(ownedByUser('home/user/notes/agent.txt'), 'what the agent writes belongs to the user');
  console.log("  the agent's file tools act as the session user");
}

// ── /api/write-file and /api/mkdir ──────────────────────────────────────────
{
  const store = new Map();
  const self = {
    env: {},
    viteDevServer: null,
    cirrusReal: null,
    sessionBasePath: '/s/quiet-heron-1234',
    sessionBasePathHydrated: true,
    appDocuments: {},
    ctx: { storage: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } },
    async hydrateSessionBasePath() {},
    getFilesystemAuthority: () => namespace,
    processes,
  };
  const post = (path, body) => handleFetch(self, new Request(`https://nimbus.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const write = await post('/api/write-file', { path: '/home/user/protected.txt', content: 'replaced' });
  assert.equal(write.status, 400, `/api/write-file wrote over a kernel-owned file: ${await write.clone().text()}`);
  assert.match((await write.json()).error, denied);
  assert.equal(text('home/user/protected.txt'), 'kept');
  const mkdir = await post('/api/mkdir', { path: '/home/user/locked/sub' });
  assert.equal(mkdir.status, 400, `/api/mkdir made a directory in a kernel-owned one: ${await mkdir.clone().text()}`);
  assert.match((await mkdir.json()).error, denied);
  assert.equal(kernel.exists('home/user/locked/sub'), false);
  const own = await post('/api/write-file', { path: '/home/user/notes/http.txt', content: 'mine' });
  assert.equal(own.status, 200, await own.clone().text());
  assert.ok(ownedByUser('home/user/notes/http.txt'), 'what /api/write-file writes belongs to the user');
  console.log('  /api/write-file and /api/mkdir act as the session user');
}

// ── files.delete: the session user, unless the embedder asks for the kernel ─
{
  const host = { processes, getFilesystemAuthority: () => namespace, async ensureRuntimeReady() {} };
  await assert.rejects(rpcDeleteFile(host, '/home/user/sticky/provisioned.txt'), denied,
    'files.delete removed a file the kernel provisioned in a sticky directory');
  assert.equal(text('home/user/sticky/provisioned.txt'), 'provisioned');
  await rpcDeleteFile(host, '/home/user/notes/editor.txt');
  assert.equal(kernel.exists('home/user/notes/editor.txt'), false, "the user's own file is deleted");
  // A user's symlink is removed as unlink(2) removes it, without searching
  // through to a target the user cannot reach.
  engine.as(CRED_SESSION_USER).symlink('/home/user/private/secret.txt', 'home/user/shortcut');
  await rpcDeleteFile(host, '/home/user/shortcut');
  assert.equal(kernel.isSymlink('home/user/shortcut'), false, 'the symlink is gone');
  assert.equal(text('home/user/private/secret.txt'), 'theirs', 'and its target is untouched');
  await rpcDeleteFile(host, '/home/user/sticky/provisioned.txt', {}, CRED_KERNEL);
  assert.equal(kernel.exists('home/user/sticky/provisioned.txt'), false, 'the embedder deletes as the kernel when it asks by name');
  console.log('  files.delete acts as the session user unless the kernel is asked for');
}

console.log('owner-surface-credential: ok');
