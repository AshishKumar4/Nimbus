#!/usr/bin/env bun
// The session's own surfaces that act as its user act with the groups its
// host gave it (Kinu ask 73; session-groups.mjs for the workspace): in a
// project setgid to the host's project group, with a group-rwx default ACL,
// each writes a file a viewer in the group made (`-rw-rw-r-- 2000 1001`), and
// files.delete removes one from a directory the viewer made: the agent's
// write_file, /api/write-file, a pid-less file RPC (the SDK's and `/rpc`'s
// writeFile), files.delete and the editor pane. Each was refused before: they
// acted as CRED_SESSION_USER, whose only group is 1000.
import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const {
  CRED_KERNEL, NimbusWorkspace, answerSupervisorOp, buildSessionSupervisorOps,
  editorViews, serveEditorFs, runTool, handleFetch, rpcDeleteFile, _rpcWriteFile,
} = await importWorkerBundle({
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/worker/src/session/supervisor-op.ts': ['answerSupervisorOp', 'buildSessionSupervisorOps'],
  'packages/worker/src/session/editor-fs.ts': ['editorViews', 'serveEditorFs'],
  'packages/worker/src/session/agent.ts': ['runTool'],
  'packages/worker/src/session/routes.ts': ['handleFetch'],
  'packages/worker/src/session/programmatic.ts': ['rpcDeleteFile'],
  'packages/worker/src/session/rpc.ts': ['_rpcWriteFile'],
});

const VIEWER = Object.freeze({ uid: 2000, gid: 2000, groups: Object.freeze([2000, 1001]), umask: 0o077 });
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, sessionGroups: [1001] });
const kernel = ws.vfs.as(CRED_KERNEL);
kernel.mkdir('home/main', { recursive: true, mode: 0o2775 });
kernel.chown('home/main', 1000, 1001);
kernel.chmod('home/main', 0o2775);
kernel.setDefaultAcl('home/main', 0o775);
const viewer = ws.vfs.as(VIEWER);
viewer.writeFile('home/main/planted.txt', 'viewer\n');
viewer.mkdir('home/main/shared');
for (const name of ['agent', 'editor', 'deleted']) viewer.writeFile(`home/main/shared/${name}.txt`, 'viewer\n');
const planted = kernel.stat('home/main/planted.txt');
assert.deepEqual([planted.uid, planted.gid, planted.mode & 0o777], [2000, 1001, 0o664], 'fixture: the viewer\'s file is the project group\'s');
const text = (path) => kernel.readFileString(path);

const store = new Map();
const host = {
  env: {},
  viteDevServer: null,
  cirrusReal: null,
  sessionBasePath: '/s/quiet-heron-1234',
  sessionBasePathHydrated: true,
  appDocuments: {},
  ctx: { storage: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } },
  async hydrateSessionBasePath() {},
  sqliteFs: ws.vfs,
  processes: ws.processes,
  getFilesystemAuthority: () => ws.filesystem,
  ensureSqliteFs() {},
  async ensureRuntimeReady() {},
  ensureFacetManager() {},
  shell: {},
  _w1SessionDestroyed: false,
};
const ops = buildSessionSupervisorOps(host);
host.serveSupervisorOp = (envelope) => ops.dispatch(envelope);
host.supervisorOp = (envelope) => answerSupervisorOp(host.serveSupervisorOp, envelope);
host.supervisorBridge = (pid) => ops.bridge(pid);

try {
  const tool = await runTool(host, 'write_file', { path: '/home/main/planted.txt', content: 'agent\n' });
  assert.equal(tool.ok, true, `the agent's write_file: ${JSON.stringify(tool)}`);
  assert.equal(text('home/main/planted.txt'), 'agent\n');

  const http = await handleFetch(host, new Request('https://nimbus.test/api/write-file', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/home/main/planted.txt', content: 'http\n' }),
  }));
  assert.equal(http.status, 200, `/api/write-file: ${await http.clone().text()}`);
  assert.equal(text('home/main/planted.txt'), 'http\n');

  await _rpcWriteFile(host, '/home/main/planted.txt', 'rpc\n');
  assert.equal(text('home/main/planted.txt'), 'rpc\n', 'a pid-less file RPC');

  await rpcDeleteFile(host, '/home/main/shared/deleted.txt');
  assert.equal(kernel.exists('home/main/shared/deleted.txt'), false, 'files.delete');

  const save = await serveEditorFs(editorViews(ws.filesystem, ws.processes.sessionCred), { type: 'fs-write', path: '/home/main/shared/editor.txt', content: 'editor\n' });
  assert.equal(save.ok, true, `the editor: ${JSON.stringify(save)}`);
  assert.equal(text('home/main/shared/editor.txt'), 'editor\n');
  console.log('  ok  the agent, /api/write-file, file RPC, files.delete and the editor act in the session\'s groups');
} finally {
  await ws.close();
}
