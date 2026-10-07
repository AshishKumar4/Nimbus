// A build as a transaction over the files it can write
// (scripts/dist-integrity.mjs: "A FAILED BUILD IS NOT DRIFT"): what every
// path is before the build, held so that a failed build puts every one of
// them back, and verified against that snapshot afterwards.
import { spawnSync } from 'node:child_process';
import {
  chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { trackedFileDigests } from './fs-walk.mjs';

/** In a kept copies directory: every held path's mode or link, and the HEAD. */
const HELD_MANIFEST = '.dist-integrity-held.json';

/**
 * The build could not run, or one of its steps failed. Never drift: the
 * tree under the output roots is as it was before the build.
 */
export class BuildFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BuildFailure';
  }
}

/** What the build did to the tree, as three sorted path lists. */
export function diffSnapshots(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, digest] of after) {
    const prior = before.get(path);
    if (prior === undefined) added.push(path);
    else if (prior !== digest) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/**
 * Run `body` as one transaction over `roots`, whose files were as `before`
 * (a snapshot taken under the checkout lock) when the build began. `body`
 * returns null when it succeeded, or what failed. Then every file under
 * `roots` is put back as `before` had it, mode included, and BuildFailure
 * is thrown: a failed build never leaves a cleaned or half-written tree
 * behind for anyone to read as drift, or to commit.
 *
 * The rollback has two sources: HEAD, for every file git can give back as
 * it was, and copies held outside the tree for the rest. If the copies
 * cannot be made, `body` never runs. If part of the rollback fails, every
 * other file is still put back, the copies are kept, and BuildFailure names
 * each file left wrong, why, and where the copies are.
 *
 * @param {{ root: string, roots: string[], before: Map<string, string> }} scope
 * @param {() => string | null} body
 */
export function transaction({ root, roots, before }, body) {
  const held = holdOutputs({ root, roots, before });
  let keep = false;
  try {
    const failed = body();
    if (failed !== null) {
      const { restored, unrestored } = restoreOutputs({ root, roots, before, held });
      keep = unrestored.length > 0;
      throw new BuildFailure(buildFailureReason({ step: failed, restored, unrestored, held: held.dir }));
    }
  } finally {
    if (!keep) rmSync(held.dir, { recursive: true, force: true });
  }
}

/**
 * What a path is, without following it: a symlink's target, or a regular
 * file's mode. A symlink is never followed, so nothing here can reach
 * outside the roots through one.
 *
 * @returns {{ link: string } | { mode: number } | null}
 */
function entryOf(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  return st.isSymbolicLink() ? { link: readlinkSync(path) } : { mode: st.mode & 0o7777 };
}

const sameEntry = (a, b) => (a === null || b === null ? a === b
  : 'link' in a ? 'link' in b && a.link === b.link : 'mode' in b && a.mode === b.mode);

/**
 * What a failed build must be able to put back: what every path under
 * `roots` is (a symlink and its target, or a regular file and its mode),
 * and a copy (in a directory under the system tmpdir, mirroring the repo's
 * paths, a symlink as the same link) of every path git cannot give back as
 * it is: one that differs from HEAD, or that HEAD does not have. Every
 * other file is HEAD's. HELD_MANIFEST in that directory records every
 * path's mode or link and the HEAD, so the copies are enough to recover
 * from by hand even if this process dies mid-build. Throws BuildFailure,
 * before anything is built, if any of it cannot be made.
 */
function holdOutputs({ root, roots, before }) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dist-integrity-held-'));
    /** @type {Map<string, { link: string } | { mode: number }>} */
    const entries = new Map();
    for (const path of before.keys()) {
      const entry = entryOf(join(root, path));
      if (entry === null) throw new Error(`${path} vanished while it was being held`);
      entries.set(path, entry);
    }
    const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...roots], {
      cwd: root, encoding: 'buffer', maxBuffer: 1 << 28,
    });
    if (status.status !== 0) throw new Error(`git status failed: ${status.stderr || status.error?.message}`);
    /** Paths git cannot give back as they are. */
    const dirty = new Set();
    /** @type {Map<string, string>} */
    const copies = new Map();
    const lines = status.stdout.toString('utf8').split('\0');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // A rename or copy is followed by its source path, which is not a file here.
      if (line[0] === 'R' || line[0] === 'C') i++;
      const path = line.slice(3);
      if (!before.has(path)) continue;
      dirty.add(path);
      const copy = join(dir, path);
      mkdirSync(dirname(copy), { recursive: true });
      const entry = entries.get(path);
      if ('link' in entry) {
        symlinkSync(entry.link, copy);
        continue;
      }
      copyFileSync(join(root, path), copy, constants.COPYFILE_FICLONE);
      copies.set(path, copy);
    }
    // What the copies alone cannot say, for a process that dies before
    // its rollback: every path's mode or link, and the HEAD the rest are.
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(dir, HELD_MANIFEST), `${JSON.stringify({ root, head, entries: Object.fromEntries(entries) })}\n`);
    return { dir, entries, dirty, copies };
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    throw new BuildFailure(
      'refusing to build — could not hold copies of the build outputs, so a failed build could not be rolled back: '
      + `${error.message}${dir ? '' : ` (the system tmpdir is ${tmpdir()})`}`,
    );
  }
}

/**
 * Put every file under `roots` back as `before` had it: remove what the
 * build added, restore what it changed or removed (a held copy, a symlink
 * with its target, or HEAD), and give every regular file its mode back.
 * Each path is attempted on its own, so one that cannot be restored never
 * stops the rest. Nothing is written through a symlink: whatever stands at
 * a path is removed before the path is restored, and a path whose
 * directory now leads outside the checkout is refused.
 *
 * @returns {{ restored: string[], unrestored: Array<{ path: string, why: string }> }}
 */
function restoreOutputs({ root, roots, before, held }) {
  /** @type {Map<string, string>} */
  const failed = new Map();
  const attempt = (path, fn) => {
    try {
      fn();
    } catch (error) {
      failed.set(path, error.code ? `${error.code}: ${error.message}` : error.message);
    }
  };
  const realRoot = realpathSync(root);
  /** Clear `path` for restoring, making sure its directory is inside the checkout. */
  const clear = (path) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    const parent = relative(realRoot, realpathSync(dirname(target)));
    if (parent.startsWith('..')) throw new Error(`its directory now leads outside the checkout (${realpathSync(dirname(target))})`);
    rmSync(target, { recursive: true, force: true });
    return target;
  };
  const { changed, added, removed } = diffSnapshots(before, trackedFileDigests(root, roots));
  for (const path of added) attempt(path, () => rmSync(join(root, path)));
  const fromHead = [];
  for (const path of [...changed, ...removed]) {
    const entry = held.entries.get(path);
    if (!held.dirty.has(path)) {
      // HEAD has it as it was. git replaces whatever stands there, symlink or not.
      attempt(path, () => clear(path));
      fromHead.push(path);
    } else if ('link' in entry) {
      attempt(path, () => symlinkSync(entry.link, clear(path)));
    } else {
      attempt(path, () => copyFileSync(held.copies.get(path), clear(path)));
    }
  }
  const restorable = fromHead.filter((path) => !failed.has(path));
  if (restorable.length > 0) {
    const restored = spawnSync('git', ['restore', '--source=HEAD', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      cwd: root, input: restorable.join('\0'), encoding: 'utf8',
    });
    if (restored.status !== 0) {
      const why = `git restore failed: ${(restored.stderr || restored.error?.message || '').trim()}`;
      for (const path of restorable) failed.set(path, why);
    }
  }
  // HEAD knows only 0644 and 0755, a copy takes the mode of its target, and
  // a build can change a file's mode without its bytes: every mode back.
  // Only a regular file is chmodded: chmod follows a symlink.
  const remoded = new Set();
  for (const [path, entry] of held.entries) {
    if (!('mode' in entry)) continue;
    attempt(path, () => {
      const now = entryOf(join(root, path));
      if (now === null || !('mode' in now) || now.mode === entry.mode) return;
      chmodSync(join(root, path), entry.mode);
      remoded.add(path);
    });
  }

  // What is still wrong is judged against the snapshot (bytes, or a link's
  // target) and each path's type and mode, not the attempts.
  const left = diffSnapshots(before, trackedFileDigests(root, roots));
  const stillWrong = new Set([...left.changed, ...left.added, ...left.removed]);
  for (const [path, entry] of held.entries) {
    if (!sameEntry(entryOf(join(root, path)), entry)) stillWrong.add(path);
  }
  const unrestored = [...stillWrong].sort().map((path) => ({
    path, why: failed.get(path) ?? 'differs from before the build after the rollback',
  }));
  const restored = [...new Set([...changed, ...removed, ...added, ...remoded])].filter((path) => !stillWrong.has(path)).sort();
  return { restored, unrestored };
}

function buildFailureReason({ step, restored, unrestored, held }) {
  const list = (lines) => `${lines.slice(0, 20).map((line) => `  ${line}`).join('\n')}${lines.length > 20 ? `\n  … and ${lines.length - 20} more` : ''}`;
  if (unrestored.length > 0) {
    return (
      `BUILD FAILED — ${step}. This is a failed build, not drift.\n\n`
      + `The tree could NOT be put back as it was before the build; ${unrestored.length} file${unrestored.length === 1 ? '' : 's'} still differ${unrestored.length === 1 ? 's' : ''} (do not commit ${unrestored.length === 1 ? 'it' : 'them'}):\n`
      + `${list(unrestored.map(({ path, why }) => `${path} — ${why}`))}\n\n`
      + `The copies the build needs are kept in ${held} (paths as in the repo, a symlink as the link; a file not there is HEAD's at the commit ${HELD_MANIFEST} names, which also lists every path's mode).\n`
      + (restored.length > 0 ? `${restored.length} other file${restored.length === 1 ? ' was' : 's were'} put back.\n` : '')
      + 'Restore the files above from those copies or HEAD, fix the build (its output is above), then rebuild.'
    );
  }
  return (
    `BUILD FAILED — ${step}. This is a failed build, not drift: it says nothing about whether dist matches src.\n\n`
    + (restored.length > 0
      ? `The tree is as it was before the build: ${restored.length} file${restored.length === 1 ? '' : 's'} the failed build removed, rewrote, added or re-moded ${restored.length === 1 ? 'was' : 'were'} put back:\n${list(restored)}\n\n`
      : 'The failed build had changed no file.\n\n')
    + 'There is nothing to commit. Fix the build (its output is above) and run again.'
  );
}
