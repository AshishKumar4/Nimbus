#!/usr/bin/env bun
// Names that begin with U+FEFF (bytes EF BB BF) in a git repository, as host
// git keeps them: a file, a nested file, a file in a directory named by a
// BOM alone, and a symlink whose target begins with one. Ours and host git
// clone the repository from the same server (git http-backend), then check
// out its first commit, reset --hard to its second, and add a file and a
// link of the same kind. After each: the same worktree (names, contents,
// link targets), the same index (host git's ls-files -s over a copy of
// ours), and status --porcelain clean on both.
//
// Red before: the clone's plan, the index and the tree walks decoded names
// with a TextDecoder that drops a leading BOM, and so did the checkout's and
// the filesystem's link targets.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostGitEnv } from './lib/facet-session.mjs';

const BOM = '\uFEFF';
const work = mkdtempSync(join(tmpdir(), 'nimbus-git-bom-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);

/** Host git talking to the server, which answers from this process's loop: not spawnSync. */
async function realGit(cwd, args) {
  const child = spawn('git', args, { cwd, env: { ...hostGitEnv(work), GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

/** Every path below `root` but .git, with its content or link target, sorted. */
function diskState(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === '.git') continue;
    const st = lstatSync(join(root, path));
    if (st.isDirectory()) out.push(`${path}/`, ...diskState(root, path));
    else out.push(`${path} ${st.isSymbolicLink() ? '-> ' + readlinkSync(join(root, path)) : readFileSync(join(root, path), 'utf8')}`);
  }
  return out;
}

/** Writes the commit's files at `dir`: `text` in each, the link to `target`. */
function writeTree(dir, text, target) {
  mkdirSync(join(dir, 'd'), { recursive: true });
  mkdirSync(join(dir, BOM), { recursive: true });
  writeFileSync(join(dir, `${BOM}top.txt`), text);
  writeFileSync(join(dir, 'd', `${BOM}nested`), text);
  writeFileSync(join(dir, BOM, 'file'), text);
  rmSync(join(dir, 'link'), { force: true });
  symlinkSync(target, join(dir, 'link'));
}

const source = join(work, 'source');
hostGit(work, ['init', '-q', '-b', 'main', source]);
writeTree(source, 'one\n', `${BOM}target`);
hostGit(source, ['add', '-A']);
hostGit(source, ['commit', '-q', '-m', 'one']);
const first = hostGit(source, ['rev-parse', 'HEAD']).trim();
writeTree(source, 'two\n', `${BOM}target2`);
hostGit(source, ['add', '-A']);
hostGit(source, ['commit', '-q', '-m', 'two']);
const second = hostGit(source, ['rev-parse', 'HEAD']).trim();
assert.ok(hostGit(source, ['ls-files', '-z']).includes(BOM), 'host git keeps the BOM in its index');
const served = join(work, 'served');
mkdirSync(served);
hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);

const server = startGitHttpServer(served);
const session = await createFacetSession(work, { realGit: true });
const user = session.vfs.as(CRED_SESSION_USER);
const host = join(work, 'host');
const ours = '/home/user/ours';
let copies = 0;

/** Ours and host git's repositories alike: worktree, index, and status clean on both. */
async function same(label) {
  const copy = session.materialize(ours.slice(1), join(work, `copy-${++copies}`));
  assert.deepEqual(diskState(copy), diskState(host), `${label}: the worktree`);
  assert.equal(hostGit(copy, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']), `${label}: the index`);
  const status = await session.git(ours, ['status', '--porcelain']);
  assert.equal(status.code, 0, `${label}: status: ${status.stderr}`);
  assert.equal(status.stdout, '', `${label}: status --porcelain is clean`);
  assert.equal(hostGit(host, ['status', '--porcelain']), '', `${label}: host git's status is clean`);
  console.log(`  ok  ${label}`);
}

try {
  const cloned = await realGit(work, ['clone', '-q', `${server.url}/repo.git`, host]);
  assert.equal(cloned.code, 0, cloned.stderr);
  const ourClone = await session.git('/home/user', ['clone', '-q', `${server.url}/repo.git`, ours]);
  assert.equal(ourClone.code, 0, ourClone.stderr);
  await same('clone');

  for (const args of [['checkout', '-q', first], ['reset', '-q', '--hard', second]]) {
    hostGit(host, args);
    const step = await session.git(ours, args);
    assert.equal(step.code, 0, `git ${args.join(' ')}: ${step.stderr}`);
    await same(`git ${args[0]}`);
  }

  writeFileSync(join(host, `${BOM}new`), 'new\n');
  symlinkSync(`${BOM}t3`, join(host, 'link2'));
  hostGit(host, ['add', '-A']);
  user.writeFile(`${ours.slice(1)}/${BOM}new`, new TextEncoder().encode('new\n'));
  user.symlink(`${BOM}t3`, `${ours.slice(1)}/link2`);
  const added = await session.git(ours, ['add', '-A']);
  assert.equal(added.code, 0, `add: ${added.stderr}`);
  const copy = session.materialize(ours.slice(1), join(work, 'copy-added'));
  assert.equal(hostGit(copy, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']), 'git add: the index');
  console.log('  ok  git add');
} finally {
  server.stop();
}

console.log('git-names-keep-bom: ok');
