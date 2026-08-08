/**
 * Guard against validating the PREVIOUS generation.
 *
 * WASI_INSTANCE_PREAMBLE_SRC is a build artifact: `bundle:facets` bakes
 * wasi/preamble.ts into wasi-instance.generated.ts. A test that reads the
 * constant after the source changed but before the bundle was regenerated
 * asserts over stale text and passes — which happened three times during the
 * CPython migration, once hiding a change that had inverted a test's premise.
 * It is the same class as dist-vs-src, which cost this repo two silent no-op
 * deploys.
 *
 * A test that silently checks the last generation is worse than no test, so
 * this fails loudly instead.
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
  'packages', 'worker', 'src', 'runtime');

/** Sources baked into wasi-instance.generated.ts by bundle-facet-workers.mjs. */
const SOURCES = [
  join(RUNTIME, 'wasi', 'preamble.ts'),
  join(RUNTIME, 'wasi', 'types.ts'),
  join(RUNTIME, 'wasi-threads.ts'),
];
const GENERATED = join(RUNTIME, 'wasi-instance.generated.ts');

export function assertGeneratedPreambleIsFresh() {
  const built = statSync(GENERATED).mtimeMs;
  const stale = SOURCES.filter((src) => {
    try { return statSync(src).mtimeMs > built; } catch { return false; }
  });
  if (stale.length > 0) {
    throw new Error(
      'wasi-instance.generated.ts is older than '
      + stale.map((s) => s.split('/').slice(-2).join('/')).join(', ')
      + ' — this test would assert over the previous generation. '
      + 'Run `bun run --cwd packages/worker bundle:facets` first.',
    );
  }
}
