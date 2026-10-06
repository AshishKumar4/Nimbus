// A workspace shell for tests that need a shell, its registry and its kernel
// (ports, DNS, process table): the one filesystem a session has (SQLite at
// `/`, /proc, /dev), in memory. `harness` and `vfs` share a store with the
// test; `mounts` adds backends to the namespace (point → VFS).

import { NimbusWorkspace } from '../../../packages/core/src/workspace/nimbus-workspace.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

export async function testBox({ harness = createSqliteVfsTestHarness(), vfs, terminal, env, cwd, mounts = {} } = {}) {
  const engine = vfs ?? new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  for (const [point, backend] of Object.entries(mounts)) files.vfs.mount(point, backend);
  const ws = await NimbusWorkspace.create({
    sql: harness.sql, transactions: harness.ctx, vfs: engine, filesystem: files, terminal, env, cwd,
  });
  return {
    workspace: ws,
    shell: ws.shell,
    kernel: ws.kernel,
    env: ws.env,
    fs: ws.fs,
    /** The session filesystem as the kernel (storage keys, no leading slash needed). */
    root: engine.as(CRED_KERNEL),
    files,
    commands: { run: (command, options) => ws.exec(command, options), registry: ws.registry },
    /** Stops the workspace's processes; the store stays (a test may share it). */
    destroy: () => { void ws.close(); },
  };
}

/**
 * A workspace over a fresh in-memory store: NimbusWorkspace.create's
 * defaults, plus whatever `options` a test sets.
 */
export function openWorkspace(options = {}) {
  const harness = createSqliteVfsTestHarness();
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, ...options });
}

/**
 * A session filesystem in memory with no workspace: `files` (what a Shell
 * binds its commands to), `root` (the store as the kernel, for setup) and
 * `view` (a command's view as the session user, uid 1000).
 */
export function memoryFiles({ harness = createSqliteVfsTestHarness() } = {}) {
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  const root = engine.as(CRED_KERNEL);
  // A session's home, as seedBaseFilesystem leaves it: the session user's.
  root.mkdir('home/user', { recursive: true });
  root.chown('home/user', 1000, 1000);
  root.mkdir('tmp', { mode: 0o1777 });
  root.chmod('tmp', 0o1777);
  return { files, root, view: files.view({ pid: 1, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } }) };
}
