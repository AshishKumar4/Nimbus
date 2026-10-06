// Nimbus's own sources as an earlier commit had them, for tests of what a
// rollback runs: `wrangler versions deploy <previous>` puts that release's code
// over the data this one wrote, so a change of stored form is tested against
// the code before it.
//
// The commit's packages/core and packages/platform sources are extracted from
// git into this process's TMPDIR, with core's dependencies linked: platform to
// the extracted copy, zod to this checkout's. It is removed when the process
// ends.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * packages/core as commit `ref` had it: an import of a module under its src
 * (such as 'vfs/sqlite-vfs.ts'), every one from the same extracted copy.
 *
 * @param {string} ref
 * @returns {(module: string) => Promise<any>}
 */
export function releasedCore(ref) {
  const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), `released-${sha.slice(0, 12)}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const archive = execFileSync(
    'git',
    ['-C', REPO, 'archive', sha, 'packages/core/src', 'packages/platform/src', 'packages/platform/package.json'],
    { maxBuffer: 1 << 30 },
  );
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  const modules = join(dir, 'packages/core/node_modules');
  mkdirSync(join(modules, '@nimbus-sh'), { recursive: true });
  symlinkSync('../../../platform', join(modules, '@nimbus-sh/platform'));
  symlinkSync(realpathSync(join(REPO, 'packages/core/node_modules/zod')), join(modules, 'zod'));
  return (module) => import(pathToFileURL(join(dir, 'packages/core/src', module)).href);
}
