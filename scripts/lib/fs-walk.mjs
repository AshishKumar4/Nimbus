// The file listings the root scripts take: what git would carry under some
// roots, and every file under a directory.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string | Uint8Array} bytes */
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * path → digest of every file under `roots` (relative to `root`) that git
 * would carry: tracked plus untracked-and-not-ignored. A regular file's
 * digest is the sha256 of its bytes. A symlink's is
 * `link:<its target>:<sha256 of the file it resolves to>` (`none` when it
 * resolves to no regular file): its target as git records it, so a symlink
 * and the file it points at never compare equal, and the bytes a build
 * reads through it, so new bytes behind an unchanged link are a change. A
 * tracked file that is not on disk is left out: absence is a state for the
 * caller to see.
 *
 * @returns {Map<string, string>}
 */
export function trackedFileDigests(root, roots) {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots],
    { cwd: root, encoding: 'buffer', maxBuffer: 1 << 28 },
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr?.toString() ?? listed.error?.message}`);
  }
  const digests = new Map();
  for (const rel of listed.stdout.toString('utf8').split('\0')) {
    if (!rel) continue;
    const path = join(root, rel);
    try {
      digests.set(rel, lstatSync(path).isSymbolicLink() ? `link:${readlinkSync(path)}:${resolvedDigest(path)}` : sha256Hex(readFileSync(path)));
    } catch {
      continue;
    }
  }
  return digests;
}

/** sha256 of the regular file `link` resolves to, or `none`. */
function resolvedDigest(link) {
  try {
    return statSync(link).isFile() ? sha256Hex(readFileSync(link)) : 'none';
  } catch {
    return 'none';
  }
}

/** Every file under `dir`, as paths relative to it; none when `dir` is absent. */
export function filesUnder(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}
