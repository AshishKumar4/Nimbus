#!/usr/bin/env bun
// A repository Nimbus makes carries the .git/config real git writes, byte
// for byte: `git init` through the supervisor's git, and clone through the
// network facet running the bundled cf-git against `git http-backend`,
// beside real git cloning the same URL. Nimbus clones one branch, shallow by
// default, so its match is `git clone --depth 1 [--branch <ref>]`; HEAD must
// match too, detached at the commit for a tag. On that config
// (core.filemode = true) a chmod shows in status, diff and add -A as it does
// in git, and a read-only command never stages it. A repository that kept
// cf-git's old `filemode = false` ignores the exec bit, as git does.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { getSymlinkRegistry } from '../../packages/core/src/vfs/symlink-registry.ts';
import { GIT_BUNDLE_CODE } from '../../packages/worker/src/git-bundle.generated.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  GIT_CEILING_DIRECTORIES: tmpdir(),
  LC_ALL: 'C',
};

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-config-'));
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
const user = rawVfs.as(CRED_SESSION_USER);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);

function realGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `real git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Real git as a child the event loop keeps serving: it fetches from this process's server. */
async function realGitAsync(cwd, ...args) {
  const child = Bun.spawn(['git', ...args], { cwd, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `real git ${args.join(' ')}: ${stderr}`);
}

async function git(cwd, ...args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd, env: { USER: 'a' },
    stdout: { write(s) { stdout += s; } },
    stderr: { write(s) { stderr += s; } },
  }, rawVfs);
  assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
  return stdout;
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** Nimbus's `git status` lines are porcelain's once colour is gone; a clean tree says so instead. */
const status = async (cwd) => {
  const out = strip(await git(cwd, 'status'));
  return out === 'nothing to commit, working tree clean\n' ? '' : out;
};
const vfsConfig = (repo) => new TextDecoder().decode(user.readFile(`${repo.replace(/^\/+/, '')}/.git/config`));
const diskConfig = (repo) => readFileSync(join(repo, '.git/config'), 'utf8');

/** Copy a VFS tree (its .git included) to disk, links as links. */
function copyOut(from, to) {
  mkdirSync(to, { recursive: true });
  for (const { name, type } of user.readdir(from)) {
    const src = `${from}/${name}`;
    const dst = join(to, name);
    if (type === 'directory') copyOut(src, dst);
    else if (type === 'symlink') symlinkSync(user.readlink(src), dst);
    else {
      writeFileSync(dst, user.readFile(src));
      chmodSync(dst, user.lstat(src).mode & 0o777);
    }
  }
}

let server;
try {
  // ── git init, then git config edits of an existing key, a new key and a new section ──
  mkdirSync(join(scratch, 'init'));
  realGit(join(scratch, 'init'), 'init', '-q');
  user.mkdir('home/user/init');
  await git('/home/user/init', 'init', '-q');
  assert.equal(vfsConfig('/home/user/init'), diskConfig(join(scratch, 'init')), 'git init -q');
  realGit(scratch, 'init', '-q', 'named');
  await git('/home/user', 'init', 'named');
  assert.equal(vfsConfig('/home/user/named'), diskConfig(join(scratch, 'named')), 'git init <dir>');
  for (const [key, value] of [['core.filemode', 'false'], ['core.editor', 'vi'], ['user.name', 'a'], ['core.filemode', 'true']]) {
    realGit(join(scratch, 'init'), 'config', key, value);
    await git('/home/user/init', 'config', key, value);
    assert.equal(vfsConfig('/home/user/init'), diskConfig(join(scratch, 'init')), `git config ${key} ${value}`);
  }
  // No migration: git init in a repository keeps the config it has.
  const legacy = '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n'
    + '\tlogallrefupdates = true\n\tsymlinks = false\n\tignorecase = true\n';
  user.writeFile('home/user/named/.git/config', legacy);
  await git('/home/user/named', 'init', '-q');
  assert.equal(vfsConfig('/home/user/named'), legacy, 're-init rewrote an existing config');

  // ── clone: the facet with the real cf-git bundle, and real git, from one smart-HTTP server ──
  const served = join(scratch, 'served');
  mkdirSync(served);
  realGit(served, 'init', '-q', '--bare', '-b', 'trunk', 'full.git');
  const work = join(scratch, 'work');
  realGit(scratch, 'clone', '-q', join(served, 'full.git'), work);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  realGit(work, 'add', 'a.txt');
  realGit(work, 'commit', '-q', '-m', 'c');
  realGit(work, 'branch', 'dev');
  realGit(work, 'tag', 'v1');
  realGit(work, 'tag', '-a', '-m', 'release', 'v2');
  realGit(work, 'push', '-q', 'origin', 'trunk', 'dev', 'v1', 'v2');
  realGit(served, 'init', '-q', '--bare', '-b', 'main', 'empty.git');
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : null;
      const child = Bun.spawn(['git', 'http-backend'], {
        env: {
          ...GIT_ENV,
          GIT_PROJECT_ROOT: served,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get('content-type') ?? '',
          CONTENT_LENGTH: body ? String(body.length) : '',
          HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
          GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
        },
        stdin: body ? new Blob([body]) : 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const out = new Uint8Array(await new Response(child.stdout).arrayBuffer());
      await child.exited;
      const split = Buffer.from(out).indexOf('\r\n\r\n');
      const headers = new Headers();
      let code = 200;
      for (const line of new TextDecoder().decode(out.subarray(0, split)).split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') code = parseInt(value, 10);
        else headers.set(name, value);
      }
      return new Response(out.subarray(split + 4), { status: code, headers });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const moduleDir = join(scratch, 'facet');
  mkdirSync(moduleDir);
  writeFileSync(join(moduleDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(moduleDir, 'git-bundle.js'), GIT_BUNDLE_CODE);
  const facet = await import(pathToFileURL(join(moduleDir, 'git-network-worker.mjs')).href);
  const bridge = new SqliteRuntimeFsBridge(kernel, rawVfs);
  const env = {
    SUPERVISOR: {
      stat: async (path) => bridge.stat(path),
      lstat: async (path) => bridge.stat(path, { followSymlinks: false }),
      hasLegacySymlinkUnder: async (path) => getSymlinkRegistry(rawVfs).hasAtOrBelow(path),
      readdir: async (path) => bridge.readdir(path),
      readFileBytes: async (path) => bridge.readFile(path),
      fsReadRange: async (path, offset, length) => bridge.readRange(path, offset, length),
      writeBatchStream: async (stream) => kernel.writeStream(stream),
      async stdout() {},
    },
  };
  let jobs = 0;
  /** The facet's two clone phases, as execGitNetwork drives them for `git clone [-b ref] url dir`. */
  async function nimbusClone(dir, url, ref) {
    const jobId = `config-${++jobs}`;
    const request = { op: 'clone', dir, url, ref, depth: 1, exclusiveDestination: true, jobId, optionsHash: 'a'.repeat(64) };
    const call = async (phase, extra) => {
      const invocationId = `${jobId}-${phase}`;
      const response = await facet.default.fetch(new Request(`http://git/git/${phase}/${invocationId}`, {
        method: 'POST',
        body: JSON.stringify({ ...request, ...extra, phase, invocationId, phaseDeadline: Date.now() + 60_000 }),
      }), env);
      const result = await response.json();
      assert.equal(result.success, true, `${phase} ${url} ${ref ?? ''}: ${result.error}`);
      return result;
    };
    const prepare = await call('clone-prepare', {});
    await call('clone-checkout', {
      prepared: prepare.prepared,
      checkoutCursor: null,
      checkoutBounds: { maxEntries: 10_000, maxDecodedBytes: 32 * 1024 * 1024, maxWallMs: 20_000 },
    });
  }

  for (const [label, repo, ref, extra] of [
    ['default branch', 'full.git', undefined, []],
    ['a branch', 'full.git', 'dev', []],
    ['a tag', 'full.git', 'v1', []],
    ['an annotated tag', 'full.git', 'v2', []],
    // cf-git speaks protocol v1, where an empty repository names no branch; v2 would name "main".
    ['an empty repository', 'empty.git', undefined, ['-c', 'protocol.version=1']],
  ]) {
    const url = `${base}/${repo}`;
    const disk = join(scratch, `clone-${jobs + 1}`);
    await realGitAsync(scratch, ...extra, 'clone', '-q', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, disk);
    const dir = `/home/user/clone-${jobs + 1}`;
    await nimbusClone(dir, url, ref);
    assert.equal(vfsConfig(dir), diskConfig(disk), `clone of ${label}: .git/config`);
    assert.equal(new TextDecoder().decode(user.readFile(`${dir.slice(1)}/.git/HEAD`)),
      readFileSync(join(disk, '.git/HEAD'), 'utf8'), `clone of ${label}: HEAD`);
  }

  // ── chmod +x in a repository Nimbus made, beside real git ──
  const disk = join(scratch, 'modes');
  const repo = '/home/user/modes';
  mkdirSync(disk);
  user.mkdir(repo.slice(1));
  realGit(disk, 'init', '-q');
  await git(repo, 'init', '-q');
  for (const [name, content] of [['mode.sh', 'echo hi\n'], ['other.txt', 'o\n']]) {
    writeFileSync(join(disk, name), content);
    chmodSync(join(disk, name), 0o644);
    user.writeFile(`${repo.slice(1)}/${name}`, content);
    user.chmod(`${repo.slice(1)}/${name}`, 0o644);
  }
  realGit(disk, 'add', '-A');
  realGit(disk, 'commit', '-q', '-m', 'c');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'c');
  const chmod = (mode) => {
    chmodSync(join(disk, 'mode.sh'), mode);
    user.chmod(`${repo.slice(1)}/mode.sh`, mode);
  };
  const agree = async (label) => {
    assert.equal(await status(repo), realGit(disk, 'status', '--porcelain'), `${label}: status`);
    for (const args of [['diff'], ['diff', '--cached'], ['ls-files', '-m'], ['diff', 'HEAD', '--name-status']]) {
      assert.equal(await git(repo, ...args), realGit(disk, ...args), `${label}: git ${args.join(' ')}`);
    }
  };
  chmod(0o755);
  await agree('chmod +x');
  assert.equal(await git(repo, 'diff'), 'diff --git a/mode.sh b/mode.sh\nold mode 100644\nnew mode 100755\n');
  assert.equal(await git(repo, 'diff', '--cached'), '', 'status and diff staged the mode');
  realGit(disk, 'add', '-A');
  await git(repo, 'add', '-A');
  await agree('chmod +x, add -A');
  assert.equal(await status(repo), 'M  mode.sh\n');
  realGit(disk, 'commit', '-q', '-m', 'x');
  await git(repo, 'commit', '-qm', 'x');
  await agree('chmod +x committed');
  const copy = join(scratch, 'modes-from-nimbus');
  copyOut(repo, copy);
  assert.equal(realGit(copy, 'ls-tree', '-r', 'HEAD'), realGit(disk, 'ls-tree', '-r', 'HEAD'));
  assert.equal(realGit(copy, 'status', '--porcelain'), '');

  // core.filemode = false, as cf-git used to write it: the exec bit is not a change.
  realGit(disk, 'config', 'core.filemode', 'false');
  await git(repo, 'config', 'core.filemode', 'false');
  chmod(0o644);
  // A later mtime makes the stat cache look again, so a refresh must keep the index mode.
  const later = new Date(Date.now() + 5000);
  utimesSync(join(disk, 'mode.sh'), later, later);
  user.utimes(`${repo.slice(1)}/mode.sh`, later.getTime(), later.getTime());
  await agree('filemode false, chmod -x');
  assert.equal(await git(repo, 'diff'), '');
  realGit(disk, 'add', '-A');
  await git(repo, 'add', '-A');
  await agree('filemode false, chmod -x, add -A');
  assert.equal(await git(repo, 'diff', 'HEAD'), '');

  console.log(`git-config-matches-git: init, git config and 5 clones byte-identical to ${realGit(scratch, '--version').trim()}; chmod agrees with it under both core.filemode values`);
} finally {
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
