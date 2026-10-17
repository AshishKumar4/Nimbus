// What a remote artifact build (remote-napi-binding, remote-napi-loader,
// remote-python-build, remote-bash-build) hands back, and how it reaches the worktree. The
// task's {out} is its log, then FILES_MARK and its files: a base64 xz tar of
// repository-relative paths. The archive is kept under
// ~/.local/state/nimbus/<tool>/, and its files are written into the worktree
// only when the build's commit is the worktree's HEAD and none of them has a
// change of its own, staged, unstaged or untracked (checked once the run is
// back, so an edit made during it counts).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NIMBUS_STATE } from './state-dir.mjs';

export const FILES_MARK = '---FILES---';

const git = (repo, args) => {
  const done = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
  return done.stdout.trim();
};

const tar = (args) => {
  const done = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`tar failed: ${done.stderr}`);
  return done.stdout;
};

/** A task's {out}: the log before FILES_MARK, and the archive after it (null when none came back). */
export function splitArchive(text) {
  const at = text.indexOf(FILES_MARK);
  if (at === -1) return { log: text, archive: null };
  const encoded = text.slice(at + FILES_MARK.length).trim();
  return { log: text.slice(0, at), archive: encoded ? Buffer.from(encoded, 'base64') : null };
}

/** Where `tool` keeps a run's files: <state>/<tool>/<time>-<name>, its directory made; add the extension. */
export function keptAs(tool, name) {
  const dir = join(NIMBUS_STATE, tool);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${new Date().toISOString().replace(/[-:.]/g, '')}-${name}`);
}

/** `bytes`, an archive, kept at `path`: the repository-relative files it holds. */
export function keepArchive(path, bytes) {
  writeFileSync(path, bytes);
  return tar(['tJf', path]).split('\n').filter((member) => member !== '' && !member.endsWith('/'));
}

/** Why `paths` may not be written into `repo` for `sha` (it is not HEAD, or one of them has a change of its own), or null. */
export function writeRefusal(repo, sha, paths) {
  if (git(repo, ['rev-parse', 'HEAD']) !== sha) return `${sha.slice(0, 12)} is not this worktree's HEAD`;
  const local = git(repo, ['status', '--porcelain', '--untracked-files=all', '--', ...paths]);
  return local ? `these have changes of their own:\n${local}` : null;
}

/** `files` of the archive at `path`, written into `repo`. */
export function extract(repo, path, files) {
  tar(['xJf', path, '-C', repo, ...files]);
}

/**
 * `files` of the archive at `path` beside commit `sha` of `repo`. Each one's
 * sha256 as built and as committed (null when the commit lacks it), in
 * `artifacts`. Those that differ, and the files the commit has under one of
 * the `replaced` directories (which the archive's files replace whole) that
 * the archive lacks, in `differing`. An empty `differing` means the build
 * reproduces the commit's artifacts byte for byte.
 */
export function compareArtifacts(repo, sha, path, files, replaced = []) {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const unpacked = mkdtempSync(join(tmpdir(), 'remote-artifacts-'));
  try {
    extract(unpacked, path, files);
    const artifacts = Object.fromEntries(files.map((file) => {
      const shown = spawnSync('git', ['-C', repo, 'show', `${sha}:${file}`], { maxBuffer: 512 * 1024 * 1024 });
      return [file, { built: digest(readFileSync(join(unpacked, file))), committed: shown.status === 0 ? digest(shown.stdout) : null }];
    }));
    const returned = new Set(files);
    const committed = replaced.length === 0 ? [] : git(repo, ['ls-tree', '-r', '--name-only', sha, '--', ...replaced]).split('\n').filter(Boolean);
    const differing = [...files.filter((file) => artifacts[file].built !== artifacts[file].committed), ...committed.filter((file) => !returned.has(file))].sort();
    return { artifacts, differing };
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}
