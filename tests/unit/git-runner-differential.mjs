#!/usr/bin/env bun
/**
 * git-runner-differential — `git` in a workspace is real git: the same
 * commands, run by git.wasm through the git runner (core runtime/git-runner.ts)
 * in a workspace with a local facet host, and by the host's git in a temporary
 * directory, print the same thing and leave the same objects.
 *
 * Dates and identities are fixed, so commit ids are equal when the trees,
 * parents and messages are; a different id is a different repository.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  await step('init', { git: [['init', '-q', '-b', 'main']] });
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
} finally {
  rmSync(hostDir, { recursive: true, force: true });
  await host.dispose?.();
}

console.log(`git-runner-differential: ${steps.length} steps print and store what host git does`);
process.exit(0);
