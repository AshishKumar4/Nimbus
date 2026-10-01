// A session host for the programmatic exec surface (packages/worker/src/session/
// programmatic.ts) over a real NimbusWorkspace: a real shell, registry,
// process supervisor and SQLite VFS. Durable Object storage is a Map, the one
// seam the session would reach outside the workspace.
//
// `commands` registers test commands in the workspace registry, the way a
// runtime or an npm bin joins it, so a test can control when a command ends
// without faking the shell that runs it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

import { NimbusWorkspace } from '../../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';

/**
 * @param {{ commands?: Record<string, import('../../../packages/core/src/substrate/lifo/commands/types.ts').Command> }} [options]
 */
export async function programmaticHost(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nimbus-programmatic-'));
  const db = new Database(join(dir, 'workspace.sqlite'));
  const harness = createSqliteVfsTestHarness(db);
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1 });
  for (const [name, command] of Object.entries(options.commands ?? {})) ws.registry.register(name, command);
  const rows = new Map();
  const held = [];
  const host = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      waitUntil: (promise) => held.push(promise),
      storage: {
        get: async (key) => rows.get(key),
        put: async (key, value) => { rows.set(key, value); },
        delete: async (key) => { rows.delete(key); },
      },
    },
    shell: ws.shell,
    shellProcessPid: ws.shellProcessPid,
    sqliteFs: ws.vfs,
    processes: ws.processes,
    portRegistry: { getAll: () => [] },
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: ws.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    ensureRuntimeReady() {},
  };
  return {
    ws,
    host,
    /** Durable shell state, by storage key. */
    rows,
    /** Work the session was asked to keep alive (ctx.waitUntil). */
    held,
    /** The workspace database, to read what the VFS stored. */
    sql: harness.sql,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
