// The node shims as the standalone factory of shims-namespace.mjs, over a real
// session: the process's supervisor is the session's own (facetSupervisor),
// every call it makes is counted in handle.log.calls, and `overrides` replaces
// or intercepts one. The namespace is the session's listing as a launch takes
// it (listAuthority), so seed the tree in `authority` before calling this; a
// peer's later writes go through authority.peer. One factory per process.

import { decodeWriteBatchStream } from '../../../packages/platform/src/w7-frame.ts';
import { generateShimsCode } from '../../../packages/worker/src/runtime/node-shims.ts';
import { createAuthority, facetSupervisor } from './resident-body.mjs';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START, listAuthority } from './shims-namespace.mjs';

export const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

/**
 * The node shims for a process of credential `cred` in `cwd`, over
 * `authority`. `overrides` is an object of the calls to replace, or a
 * function of `forward(name, args)` (the session's own answer) returning it.
 * `extraListing` is [path, stat] entries the listing gives beyond the tree:
 * a device the session lists, which a file cannot be in SQLite.
 */
export function shimsOnSession({ authority = createAuthority(), overrides = {}, cred = USER, cwd = '/home/user', bundle = {}, extraListing = [] } = {}) {
  let forward;
  const given = typeof overrides === 'function' ? overrides((name, args) => forward(name, args)) : overrides;
  const handle = facetSupervisor(authority, given, cred);
  forward = handle.forward;
  listAuthority(authority.rawVfs);
  globalThis.__nimbusTestAuthorityListing.push(...extraListing);
  globalThis.__nimbusVfsCursor = { position: authority.cursor() };
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START
      + '\n;return { fs: __fsMod, os: __osMod, process: __processMod, setTimeout: globalThis.setTimeout, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };',
  );
  const shims = factory(bundle, {}, handle.supervisor, cred, cwd, [], {}, `${cwd}/main.mjs`, cwd);
  return { authority, handle, log: handle.log, ...shims, stats: () => globalThis.__nimbusProcessFs.stats() };
}

/**
 * A writeBatchStream override: each record of the wave is reported to
 * `onRecord` as the session receives it (decoded from a branch of the wave),
 * and the wave goes on to the session unchanged. `forward` is the session's.
 */
export function observeWaves(forward, onRecord) {
  return async (stream, fence, owner) => {
    const [read, sent] = stream.tee();
    const decoded = await decodeWriteBatchStream(read);
    const reading = (async () => { for await (const record of decoded.records) onRecord(record); })();
    const answer = await forward('writeBatchStream', [sent, fence, owner]);
    await reading;
    return answer;
  };
}
