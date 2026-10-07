// Probes whose failure a release may ship with: each one named, with why,
// who approved it and when, who owns the fix, and where it is tracked.
//
// The release matrix (scripts/ci/release.mjs, graded by
// scripts/ci/lib/matrix.mjs) is green if and only if every red row is a
// probe listed here. Any other red is red. A listed probe still runs, and
// its output is kept in the release's staged.json. If a listed probe
// passes, the run is red ("<probe> passes; remove its deferral"), and so is
// one that did not run at all, so an entry ends the moment its fix lands
// and cannot sit here unseen. promote.mjs prints every deferral that
// graded the release it promotes.
//
// THIS LIST IS THE USER'S. Nothing is added to it, and no other mechanism
// uses it, without a new approval from the user, recorded in the entry's
// `approved` ("user, YYYY-MM-DD"). An agent that wants a red probe to ship
// asks for that approval; it does not write the entry and then ask.

/**
 * @typedef {object} Deferral
 * @property {string} probe     the probe, as run-all names it: its path under tests/behavioral, without .mjs
 * @property {string} reason    what fails, and why it may ship anyway
 * @property {string} approved  "user, YYYY-MM-DD"
 * @property {string} owner     who fixes it
 * @property {string} tracking  where the fix is tracked
 */

/** @type {Deferral[]} */
export const DEFERRED = [
  {
    probe: 'frameworks/nuxt-real',
    reason: "nuxi dev fails in @nuxt/cli's dev error bridge: `import_node_worker_threads.BroadcastChannel is not a constructor` "
      + "(node:worker_threads has no BroadcastChannel). The release ships with Nuxt's dev server not starting; every other framework probe is green.",
    approved: 'user, 2026-10-07',
    owner: 'ContinuedMackerel',
    tracking: 'node:worker_threads BroadcastChannel for @nuxt/cli (frameworks lane, ContinuedMackerel)',
  },
];
