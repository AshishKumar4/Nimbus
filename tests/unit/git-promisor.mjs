#!/usr/bin/env bun
// A partial clone's missing objects, fetched on demand, against host git
// doing the same over the same server (git http-backend).
//
// The clone and every fetch run through execGitNetwork and the real
// assembled facet (in-process, as the LOADER would run it), writing to the
// session's SQLite VFS; the commands run through runGitCommand.
//
//   - git clone --filter=blob:none --depth 2: the same objects as host git's;
//   - git diff <parent> --stat: the same output, in one promisor request,
//     and afterwards the same objects as host git holds after its own diff;
//   - git checkout <parent>: the same worktree and objects, in one request
//     for the commit's blobs (none if the diff already brought them);
//   - fetchMissingObjects for a blob nobody holds yet: that object only,
//     in a promisor pack;
//   - a repository with no promisor remote never fetches: a missing object
//     is missing, as git reports it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { fetchMissingObjects } from '../../packages/worker/src/git/promisor.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-promisor-'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
function hostGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, env, maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString();
}

// The session: SQLite, a user home, a supervisor the facet writes through.
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);
let owner;
// The supervisor as the session serves it: the runtime bridge, writes
// presenting the lease the binding carries.
const bridge = new SqliteRuntimeFsBridge(kernel, vfs);
const lease = () => (owner === undefined ? {} : { mutationOwner: owner });
const requests = { fetchObjects: 0 };
const supervisor = {
  async stat(path) { try { return bridge.stat(path); } catch { return null; } },
  async lstat(path) { try { return bridge.stat(path, { followSymlinks: false }); } catch { return null; } },
  async hasLegacySymlinkUnder() { return false; },
  async readdir(path) { return bridge.readdir(path); },
  async readFileBytes(path) { try { return bridge.readFile(path); } catch { return null; } },
  async fsReadRange(path, offset, length) { return bridge.readRange(path, offset, length); },
  async fsWriteRange(path, offset, bytes) { return bridge.writeRange(path, offset, bytes, { createParents: true, ...lease() }); },
  async fsTruncate(path, size) { return bridge.truncate(path, size, lease()); },
  async rename(from, to) { return bridge.rename(from, to, lease()); },
  async writeBatchStream(stream) { return kernel.writeStream(stream, lease()); },
  async stdout() {},
};
// Each execGitNetwork mints its binding with the lease it holds (a clone's), as SupervisorRPC props carry it.
adoptCtxExports({ SupervisorRPC: ({ props }) => { owner = props.mutationOwner; return supervisor; } });

const tempDir = mkdtempSync(join(work, 'facet-'));
writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
writeFileSync(join(tempDir, 'git-bundle.js'), 'export const git = {}; export const gitHttp = {};');
const facet = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);
const doCtx = { id: { toString: () => 'promisor-do' } };
const doEnv = {
  ASSETS: stagedAssets,
  LOADER: {
    load() {
      return {
        getEntrypoint() {
          return {
            async fetch(request) {
              const body = await request.clone().json().catch(() => ({}));
              if (body.op === 'fetch-objects') requests.fetchObjects++;
              return facet.default.fetch(request, { SUPERVISOR: supervisor });
            },
          };
        },
      };
    },
  },
};

async function git(cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 7,
    cred: CRED_SESSION_USER,
    args,
    cwd,
    env: { USER: 'a' },
    stdout: { write(s) { stdout += s; } },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 7, cred: CRED_SESSION_USER }),
  }, vfs, doCtx, doEnv);
  return { code, stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr };
}

/** The session repository's objects, by host git: materialize .git and ask. */
function sessionObjects(root) {
  const out = mkdtempSync(join(work, 'objects-'));
  const copy = (key) => {
    for (const entry of kernel.readdir(key)) {
      const child = key + '/' + (typeof entry === 'string' ? entry : entry.name);
      const target = join(out, child.slice(root.length));
      if (kernel.stat(child).type === 'directory') { mkdirSync(target, { recursive: true }); copy(child); }
      else writeFileSync(target, kernel.readFile(child));
    }
  };
  mkdirSync(join(out, '.git'), { recursive: true });
  copy(root + '/.git');
  return { dir: out, objects: hostObjects(out) };
}
function hostObjects(dir) {
  return hostGit(dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n').sort();
}

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  for (let commit = 0; commit < 3; commit++) {
    mkdirSync(join(source, 'src/deep'), { recursive: true });
    for (let f = 0; f < 6; f++) writeFileSync(join(source, `src/f${f}.txt`), `file ${f}\n`.repeat(20 + f) + (f % 2 === 0 ? `rev ${commit}\n` : ''));
    writeFileSync(join(source, 'src/deep/d.txt'), `deep ${commit}\n`);
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
  }
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const server = startGitHttpServer(served);
  const url = server.url + '/repo.git';
  const [parent] = hostGit(source, ['rev-parse', 'HEAD~1']).trim().split('\n');
  const host = join(work, 'host');
  hostGit(work, ['clone', '-q', '--depth', '2', '--filter=blob:none', 'file://' + join(served, 'repo.git'), host]);

  try {
    const cloned = await git('/home/user', ['clone', '--depth', '2', '--filter=blob:none', url, 'repo']);
    assert.equal(cloned.code, 0, cloned.stderr);
    assert.deepEqual(sessionObjects('home/user/repo').objects, hostObjects(host), 'clone: the objects host git holds');
    assert.equal(requests.fetchObjects, 0);

    // git diff <parent>: the parent's changed blobs in one request.
    const diff = await git('/home/user/repo', ['diff', parent, '--stat']);
    assert.equal(diff.code, 0, diff.stderr);
    assert.equal(diff.stdout, hostGit(host, ['diff', parent, '--stat']));
    assert.equal(requests.fetchObjects, 1, 'one promisor request for the diff');
    assert.deepEqual(sessionObjects('home/user/repo').objects, hostObjects(host), 'after diff: the objects host git holds');

    // git checkout <parent> in a fresh clone: the commit's blobs it lacks, in one request.
    const second = await git('/home/user', ['clone', '--depth', '2', '--filter=blob:none', url, 'repo2']);
    assert.equal(second.code, 0, second.stderr);
    const host2 = join(work, 'host2');
    hostGit(work, ['clone', '-q', '--depth', '2', '--filter=blob:none', 'file://' + join(served, 'repo.git'), host2]);
    const checkout = await git('/home/user/repo2', ['checkout', parent]);
    assert.equal(checkout.code, 0, checkout.stderr);
    hostGit(host2, ['checkout', '-q', parent]);
    assert.equal(requests.fetchObjects, 2, 'one promisor request for the checkout');
    for (const path of hostGit(host2, ['ls-files']).trim().split('\n')) {
      assert.deepEqual(Buffer.from(kernel.readFile('home/user/repo2/' + path)), readFileSync(join(host2, path)), path);
    }
    const afterCheckout = sessionObjects('home/user/repo2');
    assert.deepEqual(afterCheckout.objects, hostObjects(host2), 'after checkout: the objects host git holds');
    const promisorPacks = readdirSync(join(afterCheckout.dir, '.git/objects/pack'));
    for (const pack of promisorPacks.filter((name) => name.endsWith('.pack'))) {
      assert.ok(promisorPacks.includes(pack.replace(/pack$/, 'promisor')), pack + ' is a promisor pack');
    }
    hostGit(afterCheckout.dir, ['fsck', '--no-dangling', '--connectivity-only']);

    // In the first clone the diff already brought the parent's blobs: its checkout fetches nothing,
    // nor does a merge whose sides and base it holds.
    assert.equal((await git('/home/user/repo', ['checkout', parent])).code, 0);
    const merge = await git('/home/user/repo', ['merge', 'main']);
    assert.equal(merge.code, 0, merge.stderr);
    assert.equal(kernel.readFileString('home/user/repo/src/f0.txt'), readFileSync(join(source, 'src/f0.txt'), 'utf8'));
    assert.equal(requests.fetchObjects, 2);

    // fetchMissingObjects: exactly what was asked for.
    const lacking = hostGit(source, ['rev-parse', 'HEAD~2:src/f0.txt']).trim();
    const before = new Set(sessionObjects('home/user/repo').objects);
    const fetched = await fetchMissingObjects(doCtx, doEnv, { pid: 7, dir: '/home/user/repo', remote: 'origin', url, oids: [lacking] });
    assert.equal(fetched.fetched, 1);
    const added = sessionObjects('home/user/repo').objects.filter((line) => !before.has(line));
    assert.deepEqual(added, [lacking + ' blob']);

    // No promisor remote: nothing is fetched, and the object is missing.
    const plain = await git('/home/user', ['init', 'plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const missing = await git('/home/user/plain', ['checkout', lacking, '--', 'src/f0.txt']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, new RegExp(lacking));
    assert.equal(requests.fetchObjects, 3, 'no request without a promisor remote');
  } finally {
    server.stop();
  }
  console.log('git-promisor: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
