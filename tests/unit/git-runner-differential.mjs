#!/usr/bin/env bun
/**
 * git-runner-differential — `git` in a workspace is real git: the same
 * commands, run by git.wasm through the git runner (core runtime/git-runner.ts)
 * in a workspace with a local facet host, and by the host's git in a temporary
 * directory, print the same thing and leave the same objects.
 *
 * Dates and identities are fixed, so commit ids are equal when the trees,
 * parents and messages are; a different id is a different repository. Modes
 * too: an executable's (100755), a chmod, a checkout's.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { RUNTIMES, seedRuntime, missingRuntimeFile } from './lib/wasm-runtimes.mjs';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`git-runner-differential: SKIPPED (${missing} is not built in this tree)`);
  process.exit(0);
}

// Under V8, the engine a Nimbus facet runs: the facets the local host starts
// run on the engine that started them, and Bun's aborts in git.wasm's diff
// (bun 1.4.0, "abort() called" in the facet process). Under Bun this file
// runs itself again under node, against the built packages.
if (typeof process.versions.bun === 'string') {
  const { spawnSync } = await import('node:child_process');
  const node = spawnSync('node', [new URL(import.meta.url).pathname], { stdio: 'inherit' });
  process.exit(node.status ?? 1);
}
const { NimbusWorkspace } = await import('../../packages/core/dist/workspace/nimbus-workspace.js');
const { localFacetHost } = await import('../../packages/core/dist/runtime/local-facet-host.js');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};

const host = localFacetHost();
const { sql, transactions } = await hostSqlite();
const seeding = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user' });
for (const runtime of RUNTIMES.filter((r) => r.name === 'git')) seedRuntime(seeding.vfs, runtime);
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: host });

const hostDir = mkdtempSync(join(tmpdir(), 'git-runner-diff-'));
const hostEnv = { ...process.env, ...IDENTITY, HOME: hostDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', TZ: 'UTC' };
const exports = Object.entries(IDENTITY).map(([k, v]) => `${k}='${v}'`).join(' ');

/** One step both ways: the files it writes, then the git commands, compared output for output. */
const steps = [];
async function step(label, { files = {}, git }) {
  for (const [path, text] of Object.entries(files)) {
    execFileSync('sh', ['-c', `mkdir -p "$(dirname "${path}")" && printf %s "$1" > "${path}"`, 'sh', text], { cwd: join(hostDir, 'repo') });
    const written = await ws.exec(`mkdir -p "$(dirname 'repo/${path}')" && printf %s '${text.replaceAll("'", "'\\''")}' > 'repo/${path}'`);
    assert.equal(written.exitCode, 0, written.stderr);
  }
  for (const args of git) {
    let expected;
    try {
      expected = { code: 0, out: execFileSync('git', args, { cwd: join(hostDir, 'repo'), env: hostEnv, encoding: 'utf8' }) };
    } catch (error) {
      expected = { code: error.status, out: error.stdout };
    }
    const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
    const got = await ws.exec(`cd repo && ${exports} TZ=UTC git ${quoted}`);
    assert.equal(got.exitCode, expected.code, `${label}: git ${args.join(' ')} exit code (stderr: ${got.stderr})`);
    assert.equal(got.stdout, expected.out, `${label}: git ${args.join(' ')} output`);
  }
  steps.push(label);
}

try {
  execFileSync('mkdir', ['-p', join(hostDir, 'repo')]);
  assert.equal((await ws.exec('mkdir -p repo')).exitCode, 0);
  // What init writes: core.filemode from its probe of chmod, as on Linux.
  await step('init', { git: [['init', '-q', '-b', 'main'], ['config', '--list', '--local']] });
  await step('first commit', {
    files: { 'README.md': '# demo\n', 'src/a.js': 'export const a = 1;\n', 'src/b.js': 'export const b = 2;\n' },
    git: [['add', '-A'], ['commit', '-q', '-m', 'first'], ['log', '--format=%H %an %ad %s', '--date=iso-strict'], ['status', '--porcelain=v2', '--branch']],
  });
  await step('edit and diff', {
    files: { 'src/a.js': 'export const a = 10;\n', 'new.txt': 'new\n' },
    git: [['status', '--short'], ['diff'], ['diff', '--stat'], ['add', 'new.txt'], ['diff', '--cached', '--name-status']],
  });
  await step('second commit and history', {
    git: [['commit', '-q', '-am', 'second'], ['log', '--oneline', '--graph'], ['show', '--stat', '--format=%H%n%s', 'HEAD'], ['diff', 'HEAD~1', 'HEAD'], ['blame', '--porcelain', 'src/a.js']],
  });
  await step('branches, switch, merge', {
    git: [
      ['switch', '-q', '-c', 'topic'],
    ],
  });
  await step('topic commit', {
    files: { 'src/c.js': 'export const c = 3;\n' },
    git: [['add', 'src/c.js'], ['commit', '-q', '-m', 'topic'], ['switch', '-q', 'main'], ['merge', '-q', '--ff-only', 'topic'], ['branch', '-v'], ['log', '--format=%H %s', 'main']],
  });
  await step('tags, reset, rev-parse', {
    git: [['tag', '-a', 'v1', '-m', 'one'], ['describe', '--tags'], ['reset', '-q', '--hard', 'HEAD~1'], ['rev-parse', 'HEAD', 'HEAD^{tree}', 'v1^{commit}'], ['status', '--porcelain'], ['ls-files', '-s']],
  });
  await step('errors', { git: [['show', 'no-such-ref'], ['switch', 'no-such-branch']] });

  // Modes: an executable is stored as 100755, a chmod is a change, and a
  // checkout makes the file executable again (through the Nimbus filesystem
  // extension: preview1 has no modes).
  const sessionChmod = async (mode, path) => assert.equal((await ws.exec(`chmod ${mode} repo/${path}`)).exitCode, 0);
  const executable = async (path) => ({
    host: (statSync(join(hostDir, 'repo', path)).mode & 0o111) !== 0,
    session: ((await ws.vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).stat(`home/user/repo/${path}`))?.mode & 0o111) !== 0,
  });
  await step('an executable', { files: { 'tool.sh': '#!/bin/sh\necho tool\n' }, git: [] });
  chmodSync(join(hostDir, 'repo/tool.sh'), 0o755);
  await sessionChmod('755', 'tool.sh');
  await step('commit an executable', { git: [['add', 'tool.sh'], ['commit', '-q', '-m', 'tool'], ['ls-files', '-s', 'tool.sh'], ['log', '-1', '--format=%H']] });
  chmodSync(join(hostDir, 'repo/tool.sh'), 0o644);
  await sessionChmod('644', 'tool.sh');
  await step('a chmod is a change', { git: [['status', '--porcelain'], ['diff']] });
  await step('checkout gives the mode back', { git: [['checkout', '--', 'tool.sh'], ['status', '--porcelain']] });
  assert.deepEqual(await executable('tool.sh'), { host: true, session: true }, 'checkout: executable again');
  rmSync(join(hostDir, 'repo/tool.sh'));
  assert.equal((await ws.exec('rm repo/tool.sh')).exitCode, 0);
  await step('checkout creates it executable', { git: [['checkout', '--', 'tool.sh'], ['status', '--porcelain']] });
  assert.deepEqual(await executable('tool.sh'), { host: true, session: true }, 'checkout: created executable');
  // A hook that is not executable is not run: git says so (advice.ignoredHook).
  await step('a hook that is not executable', { files: { '.git/hooks/post-commit': '#!/bin/sh\necho ran > hook-ran\n' }, git: [['commit', '-q', '--allow-empty', '-m', 'hooked'], ['status', '--porcelain']] });
  steps.push('modes');

  // Output that is not UTF-8, byte for byte: a binary blob and a diff of a Latin-1 file.
  const binary = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) & 0xff);
  const latin1 = Buffer.from('caf\xe9 cr\xe8me\n', 'latin1');
  // Through the workspace that runs the commands: another instance over the same SQLite keeps its own content cache.
  const kernelFs = ws.vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 });
  writeFileSync(join(hostDir, 'repo/blob.bin'), binary);
  writeFileSync(join(hostDir, 'repo/latin1.txt'), latin1);
  kernelFs.writeFile('home/user/repo/blob.bin', binary);
  kernelFs.writeFile('home/user/repo/latin1.txt', latin1);
  await step('binary and latin-1', { git: [['add', 'blob.bin', 'latin1.txt'], ['commit', '-q', '-m', 'bytes']] });
  writeFileSync(join(hostDir, 'repo/latin1.txt'), Buffer.from('caf\xe9 br\xfbl\xe9e\n', 'latin1'));
  kernelFs.writeFile('home/user/repo/latin1.txt', Buffer.from('caf\xe9 br\xfbl\xe9e\n', 'latin1'));
  for (const [label, args] of [['cat-file of a binary blob', ['cat-file', 'blob', 'HEAD:blob.bin']], ['diff of a Latin-1 file', ['diff']]]) {
    const expected = execFileSync('git', args, { cwd: join(hostDir, 'repo'), env: hostEnv });
    const got = await ws.exec(`cd repo && TZ=UTC git ${args.join(' ')} > /home/user/out.bin`);
    assert.equal(got.exitCode, 0, got.stderr);
    const printed = Buffer.from(kernelFs.readFile('home/user/out.bin'));
    assert.ok(printed.equals(expected), `${label}: the bytes git printed\n  git     ${JSON.stringify(expected.toString('latin1').slice(0, 400))}\n  session ${JSON.stringify(printed.toString('latin1').slice(0, 400))}`);
  }
  steps.push('bytes');

  // Real Git owns sparse checkout too; compare both its index flags and
  // what actually remains in the working tree after each operation.
  await step('sparse fixture', {
    files: { 'docs/intro.txt': 'intro\n', 'assets/logo.txt': 'logo\n', 'src/deep/nested.txt': 'nested\n', 'other/keep.txt': 'other\n' },
    git: [['restore', 'latin1.txt'], ['add', '-A'], ['commit', '-q', '-m', 'sparse fixture']],
  });
  const sparseTree = async (label) => {
    const expected = execFileSync('find', ['.', '-type', 'f', '-not', '-path', './.git/*'], { cwd: join(hostDir, 'repo'), encoding: 'utf8' }).trim().split('\n').sort();
    const got = await ws.exec("cd repo && find . -type f -not -path './.git/*'");
    assert.equal(got.exitCode, 0, got.stderr);
    assert.deepEqual(got.stdout.trim().split('\n').sort(), expected, `${label}: working-tree files`);
  };
  for (const [label, args] of [
    ['cone init', ['init', '--cone']], ['cone set', ['set', 'src']],
    ['cone add', ['add', 'docs']], ['cone reapply', ['reapply']], ['cone disable', ['disable']],
    ['non-cone init', ['init', '--no-cone']], ['non-cone set', ['set', '/src/*', '!/src/b.js', '/README.md']],
    ['non-cone add', ['add', '/other/keep.txt']], ['non-cone reapply', ['reapply']], ['non-cone disable', ['disable']],
  ]) {
    await step(label, { git: [['sparse-checkout', ...args], ['sparse-checkout', 'list'], ['ls-files', '-t'], ['status', '--porcelain']] });
    await sparseTree(label);
  }

  // The paging backend is below Git's NO_MMAP hooks. Both index formats,
  // large enough for hashes to straddle 64 KiB pages, must still resolve
  // every object as host git does. Seed the real host-written packs, without
  // loose objects to mask a broken pack-index lookup.
  const packed = join(hostDir, 'packed');
  execFileSync('git', ['init', '-q', '-b', 'main', packed], { env: hostEnv });
  const files = Array.from({ length: 6000 }, (_, i) => [`f${i}`, `content ${i}\n`]);
  const stream = files.map(([name, text], i) => `blob\nmark :${i + 1}\ndata ${Buffer.byteLength(text)}\n${text}\n`).join('')
    + `commit refs/heads/main\ncommitter Ada <ada@example.com> 1700000000 +0000\ndata 7\npacked\n\n`
    + files.map(([name], i) => `M 100644 :${i + 1} ${name}\n`).join('') + '\ndone\n';
  execFileSync('git', ['fast-import', '--quiet'], { cwd: packed, env: hostEnv, input: stream });
  for (const version of [1, 2]) {
    const prefix = join(hostDir, `pack-v${version}`);
    const hash = execFileSync('git', ['pack-objects', '--all', '--threads=1', '--window=0', `--index-version=${version}`, prefix], { cwd: packed, env: hostEnv, encoding: 'utf8' }).trim();
    const objects = join(packed, '.git/objects');
    for (const name of readdirSync(objects)) rmSync(join(objects, name), { recursive: true, force: true });
    execFileSync('mkdir', ['-p', join(objects, 'pack')]);
    assert.equal((await ws.exec('rm -rf packed/.git/objects && mkdir -p packed/.git/objects/pack packed/.git/refs/heads')).exitCode, 0);
    for (const suffix of ['pack', 'idx', 'rev']) {
      const source = `${prefix}-${hash}.${suffix}`;
      if (!existsSync(source)) continue;
      const name = `pack-${hash}.${suffix}`;
      copyFileSync(source, join(objects, 'pack', name));
      kernelFs.writeFile(`home/user/packed/.git/objects/pack/${name}`, readFileSync(source));
    }
    for (const name of ['HEAD', 'config', 'refs/heads/main'])
      kernelFs.writeFile(`home/user/packed/.git/${name}`, readFileSync(join(packed, '.git', name)));
    for (const args of [['rev-list', '--objects', '--all'], ['log', '--format=%H %s'], ['show', '--stat', '--format=%H', 'HEAD'], ['show', 'HEAD:f2731'], ['show', 'HEAD:f5999']]) {
      const expected = execFileSync('git', args, { cwd: packed, env: hostEnv, encoding: 'utf8' });
      const quoted = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
      const got = await ws.exec(`cd packed && TZ=UTC git ${quoted}`);
      assert.equal(got.exitCode, 0, `index v${version}: ${got.stderr}`);
      assert.equal(got.stdout, expected, `index v${version}: ${args.join(' ')}`);
    }
    steps.push(`paged pack index v${version}`);
  }
} finally {
  rmSync(hostDir, { recursive: true, force: true });
  await host.dispose?.();
}

console.log(`git-runner-differential: ${steps.length} steps print and store what host git does`);
process.exit(0);
