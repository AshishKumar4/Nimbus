/**
 * Guard against validating the PREVIOUS generation.
 *
 * WASI_INSTANCE_PREAMBLE_SRC and its siblings are build artifacts:
 * `bundle:facets` bakes wasi/preamble.ts, wasi-threads.ts and friends into
 * `*.generated.ts`. A test that reads one of those constants after the
 * source changed but before the bundle was regenerated asserts over stale
 * text and passes — which happened three times during the CPython
 * migration, once hiding a change that had inverted a test's premise. A
 * test that silently checks the last generation is worse than no test.
 *
 * HOW IT USED TO ASK, AND WHY THAT WAS WRONG
 *   It compared mtimes: generated older than source ⇒ stale. Checkout
 *   order alone decides mtimes, so every fresh worktree failed this on a
 *   tree whose bytes were perfectly current — cleared by running
 *   `bundle:facets`, which changed no tracked content, i.e. by proving the
 *   guard had nothing to complain about. A check that cries wolf on a
 *   fresh clone gets deleted or worked around, so it asks the same
 *   question as the deploy gate now: regenerate, and refuse if anything
 *   moved. Content, not timestamps.
 *
 * This is scripts/dist-integrity.mjs narrowed to one bundler — same
 * mechanism, one step instead of the fixpoint, so a unit test pays ~1s
 * rather than a full build.
 */
import {
  REPO_ROOT,
  diffSnapshots,
  runBuildFixpoint,
  snapshotBuildOutputs,
} from '../../../scripts/dist-integrity.mjs';

/** Everything `bundle:facets` can write, without naming its outputs. */
const ROOTS = ['packages/worker/src'];

const REGENERATE = [{
  cwd: 'packages/worker',
  script: 'bundle:facets',
  why: 'the generated facet sources this test reads constants out of',
}];

export function assertGeneratedSourcesAreCurrent({ root = REPO_ROOT } = {}) {
  const before = snapshotBuildOutputs({ root, roots: ROOTS });
  runBuildFixpoint({ root, steps: REGENERATE });
  const after = snapshotBuildOutputs({ root, roots: ROOTS });

  const { changed, added, removed } = diffSnapshots(before, after);
  const moved = [...changed, ...added, ...removed];
  if (moved.length > 0) {
    throw new Error(
      'the generated facet sources were not current — regenerating them rewrote '
      + `${moved.join(', ')}, so this test was about to assert over the previous `
      + 'generation. They are correct now; re-run.',
    );
  }
}
