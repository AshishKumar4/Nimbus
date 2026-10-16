#!/usr/bin/env bun
// git checkout <commit> from another commit (the two-tree diff) where a
// tree's names decode to paths other than their bytes: Nimbus's paths are
// strings, each name decoded on its own, as every worktree walk decodes it.
// Host git builds each repository and runs the same commands; the exits are
// git's, and the checkout leaves the target's content in the file the reset
// wrote.
//   - A nested name led by a BOM (d/<BOM>bom), and a file in a directory
//     named by a BOM alone, written by a reset --hard first: the checkout
//     updates each.
//   - A file renamed from one name that is not UTF-8 to another (0x81 to
//     0x80, and 0x80 to 0x81): both decode to U+FFFD, one path, which the
//     checkout leaves holding the new content.
//
// Red before: the diff decoded each changed path whole, keeping the BOM the
// reset dropped, so the checkout refused the file as a local change; and it
// reported the 0x81-to-0x80 rename as an addition then a deletion of the one
// path, so the checkout deleted the file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createFacetSession } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-decoded-names-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: work,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
};

function hostGit(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, env: GIT_ENV });
  return { code: r.status, stdout: r.stdout.toString('latin1'), stderr: r.stderr.toString() };
}

function sh(cwd, args, input) {
  const r = hostGit(cwd, args, input);
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A tree of `entries` ([mode, name's bytes, hex id]), written as given. */
function tree(repo, entries) {
  const bytes = Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} `), name, Buffer.from([0]), Buffer.from(oid, 'hex')])));
  return sh(repo, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], bytes);
}

/**
 * A repository at `dir` checked out at a commit of one ASCII file, with
 * commits `from` and `to` after it, whose trees `make` writes.
 */
function repository(dir, make) {
  mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  sh(dir, ['add', 'a.txt']);
  sh(dir, ['commit', '-q', '-m', 'main']);
  const blob = (text) => sh(dir, ['hash-object', '-w', '--stdin'], text);
  const [fromTree, toTree] = make({ one: blob('one\n'), two: blob('two\n'), tree: (entries) => tree(dir, entries) });
  const from = sh(dir, ['commit-tree', fromTree, '-p', 'HEAD', '-m', 'from']);
  const to = sh(dir, ['commit-tree', toTree, '-p', from, '-m', 'to']);
  return { from, to };
}

const session = await createFacetSession(work);
const user = session.vfs.as(CRED_SESSION_USER);

/** Copy a disk tree (its .git included) into the session at `to`. */
function mirror(from, to) {
  user.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const st = lstatSync(join(from, name));
    if (st.isDirectory()) mirror(join(from, name), `${to}/${name}`);
    else user.writeFile(`${to}/${name}`, new Uint8Array(readFileSync(join(from, name))));
  }
}

/** Every file below `root` but .git's, with its text, sorted. */
function checkedOut(root, prefix = '') {
  const out = [];
  for (const { name, type } of user.readdir(prefix ? `${root}/${prefix}` : root)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === '.git') continue;
    if (type === 'directory') out.push(...checkedOut(root, path));
    else out.push(`${path} ${Buffer.from(user.readFile(`${root}/${path}`)).toString()}`);
  }
  return out.sort();
}

const BOM = Buffer.from('\uFEFF');
const nested = Buffer.concat([BOM, Buffer.from('bom')]);
const cases = {
  'a nested name led by a BOM': ({ one, two, tree }) => [
    tree([['40000', Buffer.from('d'), tree([['100644', nested, one]])]]),
    tree([['40000', Buffer.from('d'), tree([['100644', nested, two]])]]),
  ],
  'a file in a directory named by a BOM alone': ({ one, two, tree }) => [
    tree([['40000', BOM, tree([['100644', Buffer.from('file'), one]])]]),
    tree([['40000', BOM, tree([['100644', Buffer.from('file'), two]])]]),
  ],
  'a rename from 0x81 to 0x80': ({ one, two, tree }) => [tree([['100644', Buffer.from([0x81]), one]]), tree([['100644', Buffer.from([0x80]), two]])],
  'a rename from 0x80 to 0x81': ({ one, two, tree }) => [tree([['100644', Buffer.from([0x80]), one]]), tree([['100644', Buffer.from([0x81]), two]])],
};

let id = 0;
async function run(label, disk, root, args) {
  const host = hostGit(disk, args);
  const ours = await session.git(root, args);
  assert.equal(host.code, 0, `${label}: host git ${args.join(' ')}: ${host.stderr}`);
  assert.equal(ours.code, host.code, `${label}: git ${args.join(' ')} exits as git (ours: ${ours.stderr})`);
}

async function check(label, make) {
  const disk = join(work, `disk-${++id}`);
  const { from, to } = repository(disk, make);
  const root = `/home/user/case-${id}`;
  mirror(disk, root);
  await run(label, disk, root, ['reset', '-q', '--hard', from]);
  const written = checkedOut(root);
  assert.equal(written.length, 1, `${label}: the reset writes one file: ${written}`);
  const path = written[0].slice(0, -' one\n'.length);
  assert.equal(written[0], `${path} one\n`, `${label}: the reset writes the first content`);
  await run(label, disk, root, ['checkout', '-q', to]);
  assert.deepEqual(checkedOut(root), [`${path} two\n`], `${label}: the checkout leaves the target's content where the reset wrote it`);
}

// Each case on its own: one that fails is its error, and the rest still run.
const failed = [];
for (const [label, make] of Object.entries(cases)) {
  try {
    await check(label, make);
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.log(`  FAIL  ${label}: ${error.message}`);
    failed.push(label);
  }
}
assert.deepEqual(failed, [], 'every case checks out as git does');
console.log(`git-checkout-decoded-names: ok (${id} cases)`);
