// What a remote build changed under its outputs, as the client checks and
// applies it (lib/apply-patch.mjs): build.mjs's dist, rebuild-opencode.mjs's
// staged assets.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The checkout at `root` against its HEAD, under `outputs`: `patch`, as
 * `git diff --binary`, or null when nothing changed; and `blobs`, each path
 * the patch touches with the git mode and blob id left there ({ mode, blob }),
 * or null where it was removed. Made through a scratch index, so the
 * checkout's own is untouched. Throws when git cannot make them.
 */
export function outputPatch(root, outputs) {
  const scratch = mkdtempSync(join(tmpdir(), 'ci-output-patch-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  const git = (args) => {
    const done = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 30 });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
    return done.stdout;
  };
  try {
    // An output neither on disk nor at HEAD (a record never written) is no pathspec git can add.
    const present = outputs.filter((path) => existsSync(join(root, path)) || spawnSync('git', ['cat-file', '-e', `HEAD:${path}`], { cwd: root }).status === 0);
    git(['read-tree', 'HEAD']);
    git(['add', '--all', '--', ...present]);
    const patch = git(['diff', '--cached', '--binary', 'HEAD', '--', ...outputs]) || null;
    /** @type {Record<string, { mode: string, blob: string } | null>} */
    const blobs = {};
    // `:<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0` per path.
    const fields = git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD', '--', ...outputs]).split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [, mode, , blob, status] = fields[i].slice(1).split(' ');
      blobs[fields[i + 1]] = status === 'D' ? null : { mode, blob };
    }
    return { patch, blobs };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
