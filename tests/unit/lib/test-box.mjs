// A workspace shell for tests that need a shell, its registry and its kernel
// (ports, DNS, process table): the one filesystem a session has (SQLite at
// `/`, /proc, /dev), in memory. `harness` and `vfs` share a store with the
// test; `mounts` adds backends to the namespace (point → VFS).

import { NimbusWorkspace } from '../../../packages/core/src/workspace/nimbus-workspace.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';

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
