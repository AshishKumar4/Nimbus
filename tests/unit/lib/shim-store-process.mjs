// One node process's shims over a session store, in-process: the process
// works in /home/user/p, a tree it owns; its SUPERVISOR is the store's bridge
// acting as the process's own credential (as SupervisorRPC does); and the
// launcher's cursor seed is in place, so the first ACQUIRE is answered rather
// than poisoned. For the coherence tests: what the process's own writes do to
// its cached cells, and what a peer's do.

import { VFS_WRITE_LEDGER_SOURCE } from '../../../packages/core/src/_shared/vfs-write-ledger.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { generateShimsCode } from '../../../packages/worker/src/runtime/node-shims.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { processBridge } from './process-bridge.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './shims-namespace.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
export const PROCESS_DIR = '/home/user/p';

/**
 * @param {{ seed?: (vfs: any) => void, writer?: string }} [options]
 *   `seed` adds kernel-written tree before it is handed to the user;
 *   `writer` activates that append writer and gives the supervisor the
 *   ranged, append and metadata ops (fsWriteRange, fsTruncate, fsAppend,
 *   fsAppendAck, utimes, chmod, chown) a FileHandle reaches.
 */
export function shimStoreProcess({ seed, writer } = {}) {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const bridge = processBridge(rawVfs, rawVfs.as(USER));
  const dec = new TextDecoder();
  vfs.mkdir(PROCESS_DIR, { recursive: true });
  seed?.(vfs);
  if (writer) rawVfs.activateAppendWriter(1, writer);
  const ownTree = (path = '') => {
    for (const entry of vfs.readdir(path)) {
      const at = path ? `${path}/${entry.name}` : entry.name;
      vfs.chown(at, USER.uid, USER.gid);
      if (entry.type === 'directory') ownTree(at);
    }
  };
  ownTree();

  const supervisor = {
    readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
    writeFile: (p, c) => bridge.writeFile(p, c),
    stat: (p) => bridge.stat(p),
    lstat: (p) => bridge.stat(p, { followSymlinks: false }),
    readdir: (p) => bridge.readdir(p),
    exists: async (p) => (await bridge.stat(p)) !== null,
    access: (p, m) => bridge.access(p, m),
    mkdir: (p) => bridge.mkdir(p, { recursive: true }),
    fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
    fsAcquire: (epoch, cursor, options) => bridge.acquire(epoch, cursor, options),
    ...(writer ? {
      fsWriteRange: (p, o, b) => bridge.writeRange(p, o, b),
      fsTruncate: (p, s) => bridge.truncate(p, s),
      async fsAppend(p, moduleId, operationId, bytes) {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return bridge.appendOnce(p, 1, writer, moduleId, Number(operationId), digest, bytes);
      },
      fsAppendAck: (moduleId, operationId) => bridge.acknowledgeAppend(1, writer, moduleId, Number(operationId)),
      utimes: (p, a, m) => bridge.utimes(p, a, m),
      chmod: (p, m) => bridge.chmod(p, m),
      chown: (p, u, g, o) => bridge.chown(p, u, g, o),
    } : {}),
  };

  // The supervisor stamps a facet's bundle with the cursor it was read at,
  // and the launcher seeds globalThis.__nimbusVfsCursor from it
  // (FacetVfsState.cursor -> facets/manager.ts). Without that seed the first
  // ACQUIRE carries a null epoch and is answered with a poison.
  globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };

  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };',
  );
  declareNamespace({
    metadata: { 'home/user/p': { type: 'directory', size: 0, mode: 0o755, uid: USER.uid, gid: USER.gid } },
    manifest: { 'home/user': ['p'], 'home/user/p': [] },
  });
  const { fs, setTimeout } = factory({}, {}, supervisor, USER, PROCESS_DIR, [], {}, `${PROCESS_DIR}/s.mjs`, PROCESS_DIR);
  return { rawVfs, vfs, bridge, supervisor, fs, setTimeout, stats: globalThis.__nimbusVfsCoherence };
}
