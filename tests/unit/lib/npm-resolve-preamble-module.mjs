// The resolver facets' preamble (worker loaders/npm-resolve-preamble.ts) as
// the facet module evaluates it: an ES module, its builtin imports included,
// with `names` exported for a test to call.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NPM_RESOLVE_PREAMBLE } from '../../../packages/worker/src/loaders/npm-resolve-preamble.ts';

export async function importResolvePreamble(names) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-resolve-preamble-'));
  try {
    const file = join(dir, 'facet.mjs');
    writeFileSync(file, `${NPM_RESOLVE_PREAMBLE}\nexport { ${names.join(', ')} };\n`);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
