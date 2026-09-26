// cf-git's internals, for tests that exercise them directly.
//
// cf-git exports its public API only, so a test appends an `export { ... }`
// of the internals it needs to cf-git's source and imports that. The copy is
// bundled with esbuild, resolving cf-git's own imports (crc-32, pako, ...)
// from the installed package's directory exactly as the package itself
// resolves them, and written to this process's TMPDIR, never into
// node_modules. It is removed when the process ends.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { build } from 'esbuild';

let staging = null;

/**
 * Import `source` (cf-git's index.js text, as installed or as a test built it)
 * with `export { <names> }` appended, resolving as `cfGitDir`'s own index.js.
 */
export async function importCfGitInternals(source, names, { cfGitDir, label = 'internals' }) {
  if (!staging) {
    staging = mkdtempSync(join(tmpdir(), 'cf-git-internals-'));
    const dir = staging;
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  const outfile = join(staging, `${label}-${randomUUID()}.mjs`);
  await build({
    stdin: {
      contents: `${source}\nexport { ${names.join(', ')} };\n`,
      resolveDir: cfGitDir,
      sourcefile: join(cfGitDir, 'index.js'),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}
