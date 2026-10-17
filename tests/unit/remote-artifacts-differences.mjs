#!/usr/bin/env bun
// What a remote artifact build returns, against the commit it built
// (scripts/ci/lib/remote-artifacts.mjs compareArtifacts): the CI scripts
// exit 0 only when it is the commit's, byte for byte, and 1 when there is
// anything to commit; each file's digests, built and committed, are the
// receipt the recipe builds keep.
//   - identical files: nothing differs;
//   - a changed byte, a file the commit lacks: each differs;
//   - a file the commit has under a directory the build replaces whole, and
//     that the build no longer makes: differs (it is deleted on write).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compareArtifacts } from '../../scripts/ci/lib/remote-artifacts.mjs';

const differences = (...args) => compareArtifacts(...args).differing;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const repo = mkdtempSync(join(tmpdir(), 'remote-artifacts-repo-'));
const built = mkdtempSync(join(tmpdir(), 'remote-artifacts-built-'));
const run = (cwd, command, args) => {
  const done = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(done.status, 0, `${command} ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
};
const put = (root, file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
/** An archive of `files` as the build tree holds them, as a remote build returns it. */
const archive = (files) => {
  const path = join(built, `out-${Math.random().toString(16).slice(2)}.tar.xz`);
  run(built, 'tar', ['cJf', path, ...files]);
  return path;
};

try {
  run(repo, 'git', ['init', '-q']);
  run(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root']);
  put(repo, 'assets/loader/a1/loader.mjs', 'loader');
  put(repo, 'assets/loader/a1/provenance.json', '{"a":1}');
  put(repo, 'src/generated.ts', 'export const A = 1;\n');
  run(repo, 'git', ['add', '-A']);
  run(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'artifacts']);
  const sha = run(repo, 'git', ['rev-parse', 'HEAD']);
  const files = ['assets/loader/a1/loader.mjs', 'assets/loader/a1/provenance.json', 'src/generated.ts'];

  put(built, 'assets/loader/a1/loader.mjs', 'loader');
  put(built, 'assets/loader/a1/provenance.json', '{"a":1}');
  put(built, 'src/generated.ts', 'export const A = 1;\n');
  assert.deepEqual(differences(repo, sha, archive(files), files, ['assets/loader']), [], 'the same bytes: nothing to commit');

  put(built, 'src/generated.ts', 'export const A = 2;\n');
  const changed = compareArtifacts(repo, sha, archive(files), files, ['assets/loader']);
  assert.deepEqual(changed.differing, ['src/generated.ts'], 'a changed byte');
  assert.deepEqual(changed.artifacts['src/generated.ts'], { built: sha256('export const A = 2;\n'), committed: sha256('export const A = 1;\n') }, 'its receipt: both digests');
  assert.deepEqual(changed.artifacts['assets/loader/a1/loader.mjs'], { built: sha256('loader'), committed: sha256('loader') });
  put(built, 'src/generated.ts', 'export const A = 1;\n');

  // A new loader build: its directory is new, the old one goes.
  put(built, 'assets/loader/b2/loader.mjs', 'loader');
  put(built, 'assets/loader/b2/provenance.json', '{"a":1}');
  const moved = ['assets/loader/b2/loader.mjs', 'assets/loader/b2/provenance.json', 'src/generated.ts'];
  assert.equal(compareArtifacts(repo, sha, archive(moved), moved, ['assets/loader']).artifacts['assets/loader/b2/loader.mjs'].committed, null, 'a file the commit lacks: no committed digest');
  assert.deepEqual(differences(repo, sha, archive(moved), moved, ['assets/loader']), [
    'assets/loader/a1/loader.mjs', 'assets/loader/a1/provenance.json', 'assets/loader/b2/loader.mjs', 'assets/loader/b2/provenance.json',
  ], 'files the commit lacks, and the replaced directory\'s files the build no longer makes');
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(built, { recursive: true, force: true });
}
console.log('remote-artifacts-differences: same bytes, a changed byte, a moved build');
