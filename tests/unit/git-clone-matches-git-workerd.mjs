#!/usr/bin/env bun
// @tier slow — drives a local workerd; CI median 28 s wall, 28 s CPU, 1.0 GiB peak (6 runs, 2026-10-06)
/**
 * git-clone-matches-git-workerd — what Nimbus's `git clone` leaves in .git is
 * what real git's leaves.
 *
 * Clone keeps its own front door (a streamed checkout in the network facet:
 * real git's checkout through the WASI filesystem measured about 30x slower,
 * spike/git-real/measure-checkout.mjs). Everything after the clone is real
 * git, so the clone must hand it exactly the repository real git would have
 * made: the same HEAD, config, refs, packed-refs and shallow file, byte for
 * byte, and the same index but for the stat data, which describes the
 * filesystem each was written on.
 *
 * A fixture repository (nested directories, an executable, a symlink, an empty
 * file, a non-ASCII name, branches, annotated and light tags) is served by
 * host git's http-backend; host git 2.53 clones it, and so does a session on
 * local workerd (apps/probe).
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const work = mkdtempSync(join(tmpdir(), 'git-clone-matches-'));
const env = {
  ...process.env, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

// ── the fixture ─────────────────────────────────────────────────────────────
const src = join(work, 'src');
mkdirSync(join(src, 'lib/deep/er'), { recursive: true });
git(work, 'init', '-q', '-b', 'main', src);
writeFileSync(join(src, 'README.md'), '# fixture\n');
writeFileSync(join(src, 'lib/a.js'), 'export const a = 1;\n');
writeFileSync(join(src, 'lib/deep/er/b.txt'), 'b\n'.repeat(1000));
writeFileSync(join(src, 'empty'), '');
writeFileSync(join(src, 'run.sh'), '#!/bin/sh\necho hi\n');
chmodSync(join(src, 'run.sh'), 0o755);
symlinkSync('lib/a.js', join(src, 'link'));
writeFileSync(join(src, 'naïve café.txt'), 'unicode\n');
git(src, 'add', '-A');
git(src, 'commit', '-q', '-m', 'first');
git(src, 'tag', 'light');
git(src, 'branch', 'side');
writeFileSync(join(src, 'lib/a.js'), 'export const a = 2;\n');
git(src, 'commit', '-q', '-am', 'second');
git(src, 'tag', '-a', 'v1', '-m', 'version one');
git(work, 'clone', '-q', '--bare', src, join(work, 'served/fixture.git'));

// ── host git's http-backend over HTTP ───────────────────────────────────────
const backend = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim() + '/git-http-backend';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  console.log(`git-clone-matches-git-workerd: http-backend ${req.method} ${url.pathname}${url.search}`);
  const cgi = spawn(backend, [], {
    env: {
      ...env, GIT_PROJECT_ROOT: join(work, 'served'), GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: req.headers['content-length'] ?? '',
      HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(cgi.stdin);
  const chunks = [];
  cgi.stdout.on('data', (c) => chunks.push(c));
  cgi.on('close', () => {
    const out = Buffer.concat(chunks);
    const split = out.indexOf('\r\n\r\n');
    const head = out.subarray(0, split).toString('latin1');
    let status = 200;
    for (const line of head.split('\r\n')) {
      const at = line.indexOf(':');
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else res.setHeader(name, value);
    }
    res.writeHead(status);
    res.end(out.subarray(split + 4));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/fixture.git`;

// ── host git's clone ───────────────────────────────────────────────────────
const hostClone = join(work, 'host-clone');
// Asynchronously: the server answering it runs on this event loop.
await new Promise((resolve, reject) => {
  const child = spawn('git', ['clone', '-q', '--depth', '1', url, hostClone], { cwd: work, env, stdio: 'inherit' });
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`host git clone exited ${code}`))));
});

/** The files under .git that a clone writes and git reads as they are, by path relative to .git. */
function gitFiles(read, list) {
  const files = {};
  for (const name of list) files[name] = read(name);
  return files;
}
const hostDotGit = join(hostClone, '.git');
const hostRefs = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path); else hostRefs.push(relative(hostDotGit, path));
  }
};
walk(join(hostDotGit, 'refs'));
const FILES = ['HEAD', 'config', 'packed-refs', 'shallow', ...hostRefs.sort()];

/**
 * An index with the stat data of every entry zeroed (ctime, mtime, dev, ino,
 * uid, gid: they describe the filesystem the index was written on) and the
 * trailing checksum dropped (it covers them). Everything else, the size of
 * each file included, is compared as it is.
 */
function indexWithoutStat(bytes) {
  const index = Buffer.from(bytes);
  assert.equal(index.toString('latin1', 0, 4), 'DIRC', 'an index');
  const version = index.readUInt32BE(4);
  assert.ok(version === 2 || version === 3, `index version ${version}: v4 entries are prefix-compressed and not walked here`);
  const count = index.readUInt32BE(8);
  let at = 12;
  for (let i = 0; i < count; i++) {
    // ctime, mtime, dev, ino (bytes 0-24) and uid, gid (28-36); mode (24-28) and size (36-40) stay.
    index.fill(0, at, at + 24);
    index.fill(0, at + 28, at + 36);
    const flags = index.readUInt16BE(at + 60);
    const header = 62 + (version === 3 && (flags & 0x4000) !== 0 ? 2 : 0);
    // The name, then 1-8 NULs to a multiple of 8 from the entry's start.
    at += (header + (flags & 0xfff) + 8) & ~7;
  }
  return index.subarray(0, index.length - 20);
}

const hostFiles = gitFiles((name) => {
  try { return readFileSync(join(hostDotGit, name)); } catch { return null; }
}, FILES);
const hostIndex = indexWithoutStat(readFileSync(join(hostDotGit, 'index')));

// ── the session's clone ────────────────────────────────────────────────────
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe);
  try {
    console.log('git-clone-matches-git-workerd: cloning in the session');
    const cloned = await terminal.run(`git clone -q ${url} c`, 300_000);
    console.log(`git-clone-matches-git-workerd: clone exited ${cloned.status}`);
    assert.equal(cloned.status, 0, cloned.stdout);
    const read = async (name) => {
      const r = await terminal.run(`base64 -w0 c/.git/${name} 2>/dev/null || echo MISSING`, 60_000);
      const text = r.stdout.trim();
      return text === 'MISSING' || text === '' && r.status !== 0 ? null : Buffer.from(text, 'base64');
    };
    const sessionFiles = {};
    for (const name of FILES) sessionFiles[name] = await read(name);
    const sessionRefs = (await terminal.run('cd c/.git && find refs -type f | sort; cd ../..', 60_000)).stdout.trim().split('\n').filter(Boolean);
    const differences = [];
    if (JSON.stringify(sessionRefs) !== JSON.stringify(hostRefs.sort())) differences.push(`refs: session ${JSON.stringify(sessionRefs)}, git ${JSON.stringify(hostRefs)}`);
    for (const name of FILES) {
      const a = hostFiles[name];
      const b = sessionFiles[name];
      if (a === null && b === null) continue;
      if (a === null || b === null || !a.equals(b)) {
        differences.push(`${name}:\n  git     ${a === null ? '(none)' : JSON.stringify(a.toString('utf8'))}\n  session ${b === null ? '(none)' : JSON.stringify(b.toString('utf8'))}`);
      }
    }
    const sessionIndexBytes = await read('index');
    const sessionIndex = sessionIndexBytes === null ? null : indexWithoutStat(sessionIndexBytes);
    if (sessionIndex === null || !hostIndex.equals(sessionIndex)) {
      differences.push(`index (stat data aside): git ${hostIndex.length} bytes, session ${sessionIndex?.length ?? 'none'}; `
        + `first difference at byte ${sessionIndex === null ? 0 : [...hostIndex].findIndex((byte, i) => byte !== sessionIndex[i])}`);
    }
    if (differences.length > 0) {
      console.log(differences.join('\n'));
      assert.fail(`${differences.length} differences from real git's clone`);
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(`git-clone-matches-git-workerd: .git matches real git's (${FILES.length} files and the index)`);
process.exit(0);
