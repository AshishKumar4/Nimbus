// Backends a composite filesystem mounts in the refinement tests, beside the
// SQLite kernel: shapes the model must also answer for.

import { MemoryVFS } from '../../../packages/core/src/vfs/memory.ts';

/**
 * A backend that keeps no modes: an in-memory filesystem whose stats (its
 * own, and readdir's) carry no mode, uid or gid. Its synchronous face is
 * itself. Write through `memory` or the returned view alike.
 */
export function modelessBackend(memory = new MemoryVFS()) {
  const bare = (stat) => { if (stat === null) return null; const { mode, uid, gid, ...rest } = stat; return rest; };
  const vfs = Object.assign(Object.create(memory), {
    stat: (path, options) => bare(memory.stat(path, options)),
    readdir: (path) => memory.readdir(path).map((e) => ({ ...e, stat: e.stat && bare(e.stat) })),
  });
  vfs.sync = vfs;
  return vfs;
}
