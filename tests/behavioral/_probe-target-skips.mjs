// _probe-target-skips.mjs — probes the runner must not run against a
// bearer-token probe target, and why. One list, read by everything that
// drives the suite at a probe target: `_staging-target.mjs test` and
// `.github/workflows/behavioral.yml`.
//
// Print it for a shell: `bun tests/behavioral/_probe-target-skips.mjs`

export const PROBE_TARGET_SKIPS = [
  // Real-repo installs against a live remote. Expensive in time and
  // money, and Markflow is a proven baseline — run these by hand, on
  // demand, with a reason.
  'frameworks/markflow-clickthrough',
  'frameworks/markflow-real',
  // hosted-demo-only surfaces. `apps/probe` has no demo OAuth and no
  // /api/sdk-smoke, so these fail for the target's shape rather than for
  // anything the change did. Verify them on `nimbus-staging` in a
  // browser (the demo's login is interactive by design).
  'sdk/new/live-sdk-smoke',
  'sdk/new/live-sdk-remote-smoke',
  'auth/new/hosted-demo-browser-auth',
  'auth/new/hosted-demo-launch-oauth',
];

if (import.meta.main) process.stdout.write(PROBE_TARGET_SKIPS.join(','));
