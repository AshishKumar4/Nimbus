// The filesystem a launch's module map is built from, for tests of the
// bundle builders in facets/manager.ts: the real supervisor bridge
// (process-bridge.mjs, the shared helper) over an in-memory SqliteVFS, seeded
// with a test's files. A test states its tree; it never re-implements the
// bridge.
//
// launchFs({ 'home/user/a.js': 'text', ... }) returns { fs, reads, stats }.
// `fs` is what the builders take. `reads` and `stats` list, in order, every
// path the builders read and stat (leading '/' stripped), for tests that
// assert what was, or was never, touched.

import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { processBridge } from './process-bridge.mjs';

const encoder = new TextEncoder();
const strip = (path) => String(path).replace(/^\/+/, '');

export function launchFs(files, { directories = [] } = {}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  for (const dir of directories) kernel.mkdir(strip(dir), { recursive: true, mode: 0o755 });
  for (const [path, content] of Object.entries(files)) {
    const key = strip(path);
    const parent = key.slice(0, key.lastIndexOf('/'));
    if (parent) kernel.mkdir(parent, { recursive: true, mode: 0o755 });
    kernel.writeFile(key, typeof content === 'string' ? encoder.encode(content) : content, { mode: 0o644 });
  }
  const bridge = processBridge(raw, kernel);
  const reads = [];
  const stats = [];
  const fs = new Proxy(bridge, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== 'function') return value;
      if (name === 'readFile') return (path, ...rest) => { reads.push(strip(path)); return value.call(target, path, ...rest); };
      if (name === 'stat') return (path, ...rest) => { stats.push(strip(path)); return value.call(target, path, ...rest); };
      return value.bind(target);
    },
  });
  return { fs, reads, stats };
}
