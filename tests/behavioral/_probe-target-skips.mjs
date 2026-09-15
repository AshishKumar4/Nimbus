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
  // Follows the landing page's no-sign-in action into a live anonymous
  // session. `/try` is a hosted-demo route backed by the demo's D1
  // (`demo_sessions`) and its `ANON_RATE_LIMITER` binding; `apps/probe`
  // declares neither and routes nothing but the core Nimbus surface, so
  // the chain cannot complete there for the target's shape. Run it
  // against a hosted-demo deployment: `bun run staging:test`.
  //
  // This one is skipped for a capability that was ALREADY invisible once
  // — unreachable on production for weeks because nothing asserted the
  // landing page offered it. So its landing-page half is duplicated as a
  // hard assertion in `tests/unit/hosted-demo-anon-session.mjs`, which
  // runs on every target and cannot be skipped by a target's shape. If
  // that unit assertion is ever removed, this skip becomes a blind spot
  // again.
  'auth/new/hosted-demo-anon-launch',
];

if (import.meta.main) process.stdout.write(PROBE_TARGET_SKIPS.join(','));
