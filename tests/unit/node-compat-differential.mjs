#!/usr/bin/env bun
// lifo's node and Node's fs over a session client (createNodeCompat over
// nodeFacesOf) answer one program value for value over the same files
// (Kinu ask 67's differential, tests/unit/lib/node-fs-differential.mjs):
// what each reads, how a missing file fails, every Stats field, readdir's
// types, mkdir -p, rename, and unlink of a directory. The probe
// sdk/new/node-compat-differential compares the hosted node's with the
// facade's, so the three agree. The client here makes the session's file
// calls over the workspace's own files as its user, as the session does.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createNodeCompat, nodeFacesOf } from '../../packages/core/src/node-compat/index.ts';
import { sessionFileStatOf } from '../../packages/core/src/runtime/session-protocol.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { differential, fixtureFiles, fixtureLink, programSource } from './lib/node-fs-differential.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
const lease = ws.filesystem.openHost(CRED_SESSION_USER);
const fs = lease.fs;
const decoder = new TextDecoder();
const files = {
  read: async (path) => { const bytes = await fs.readFile(path); return bytes === null ? null : decoder.decode(bytes); },
  readBytes: async (path) => fs.readFile(path),
  write: async (path, content) => { await fs.writeFile(path, content); },
  stat: async (path) => sessionFileStatOf(await fs.stat(path)),
  lstat: async (path) => sessionFileStatOf(await fs.stat(path, { followSymlinks: false })),
  readlink: async (path) => fs.readlink(path),
  rename: async (from, to) => { await fs.rename(from, to); },
  chmod: async (path, mode) => { await fs.chmod(path, mode); },
  list: async (path) => fs.readdir(path),
  mkdir: async (path, options) => fs.mkdir(path, options ?? { recursive: true }),
  exists: async (path) => (await fs.stat(path)) !== null,
  delete: async (path, options) => { await fs.remove(path, { recursive: options?.recursive === true }); },
  unlink: async (path) => fs.unlink(path),
  rmdir: async (path) => fs.rmdir(path),
  appendFile: async () => { throw new Error('not in this program'); },
  symlink: async (target, path) => fs.symlink(target, path),
  realpath: async (path) => fs.realpath(path),
  truncate: async (path, size) => { await fs.truncate(path, size); },
  chown: async (path, uid, gid, options) => { await fs.chown(path, uid, gid, options); },
};

try {
  const root = '/home/user/differential';
  for (const [path, content] of Object.entries(fixtureFiles)) {
    await files.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`);
    await files.write(`${root}/${path}`, content);
  }
  await files.symlink(fixtureLink.target, `${root}/${fixtureLink.path}`);
  await files.write(`${root}/program.js`, programSource('lifo'));
  const lifo = await ws.exec(`cd ${root} && node program.js`);
  assert.equal(lifo.exitCode, 0, lifo.stderr);
  const facade = await differential(createNodeCompat(nodeFacesOf({ files }), { cwd: root }).fs, 'facade');
  const ran = JSON.parse(lifo.stdout);
  const drifted = Object.keys({ ...facade, ...ran }).filter((key) => JSON.stringify(facade[key]) !== JSON.stringify(ran[key]));
  assert.deepEqual(drifted.map((key) => ({ key, facade: facade[key], lifo: ran[key] })), [], 'value for value');
} finally {
  await lease.dispose();
  await ws.close();
}
console.log('node-compat-differential: lifo\'s node and the facade answer one program alike');
