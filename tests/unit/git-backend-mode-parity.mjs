#!/usr/bin/env bun
// The git facet's buffered backend asks the session for the permission bits
// git asked for, as the session's own backend does (and as a program's write
// with that mode does), and the session makes each file under its own
// creation policy, here a 002 umask: same request, same file. The facet's own
// record of what it wrote is git's view of it: executable or not.
//
// Red before: the buffered backend sent 0644 or 0755 whatever was asked
// (0600 and 0444 were lost, and a 002 umask's group write never applied).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { WaveIngest } from '../../packages/core/src/runtime/wave-ingest.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

// null: no mode asked for.
const REQUESTS = { 'plain.txt': null, 'run.sh': 0o777, 'private.txt': 0o600, 'readonly.txt': 0o444 };
const AT_SESSION = { 'plain.txt': 0o664, 'run.sh': 0o775, 'private.txt': 0o600, 'readonly.txt': 0o444 };
const GIT_VIEW = { 'plain.txt': 0o644, 'run.sh': 0o755, 'private.txt': 0o644, 'readonly.txt': 0o644 };

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o775 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as({ ...CRED_SESSION_USER, umask: 0o002 });
user.mkdir('home/user/facet', { mode: 0o775 });
user.mkdir('home/user/program', { mode: 0o775 });
const modesAt = (dir) => Object.fromEntries(Object.keys(REQUESTS).map((name) => [name, kernel.stat(`home/user/${dir}/${name}`).mode & 0o7777]));

// The facet's buffered backend, writing through its waves into the session.
const tempDir = mkdtempSync(join(tmpdir(), 'nimbus-git-backend-mode-parity-'));
try {
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), `
export const git = {
  async fetch({ fs, dir }) {
    const requests = ${JSON.stringify(REQUESTS)};
    const seen = {};
    for (const [name, mode] of Object.entries(requests)) {
      const path = dir + '/' + name;
      await fs.promises.writeFile(path, name, mode === null ? undefined : { mode });
      seen[name] = (await fs.promises.stat(path)).mode & 0o7777;
    }
    globalThis.__gitView = seen;
  },
};
`);
  const facetWorker = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);
  const waves = new WaveIngest(null);
  const bridge = new SqliteRuntimeFsBridge(user, vfs);
  const supervisor = {
    async stat(p) { try { return bridge.stat(p); } catch { return null; } },
    async lstat(p) { try { return bridge.lstat(p); } catch { return null; } },
    async readdir(p) { try { return bridge.readdir(p).map((entry) => (typeof entry === 'string' ? entry : entry.name)); } catch { return []; } },
    async readFileBytes(p) { try { return bridge.readFile(p); } catch { return null; } },
    async writeBatchStream(stream) { return waves.writeStream(user, stream); },
    async stdout() {},
  };
  const response = await facetWorker.default.fetch(new Request('http://git/op', {
    method: 'POST',
    body: JSON.stringify({ op: 'fetch', dir: '/home/user/facet', remote: 'origin' }),
  }), { SUPERVISOR: supervisor });
  const result = await response.json();
  assert.equal(result.success, true, result.error);
  assert.deepEqual(globalThis.__gitView, GIT_VIEW, "the facet's own stat of each file it wrote is git's view: executable or not");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// What the session makes of the same requests from a program's writes.
for (const [name, mode] of Object.entries(REQUESTS)) user.writeFile(`home/user/program/${name}`, name, mode === null ? undefined : { mode });

assert.deepEqual(modesAt('program'), AT_SESSION, "a program's writes: the bits asked for, under the session's 002 umask");
assert.deepEqual(modesAt('facet'), AT_SESSION, "the facet's files: the same");
console.log('git-backend-mode-parity: PASS');
