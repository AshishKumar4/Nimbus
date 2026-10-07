// _probe-target-skips.mjs — probes the runner must not run against a
// bearer-token probe target, and why. One list, read by everything that
// drives the suite at a probe target: scripts/ci/remote-probes.mjs and
// `.github/workflows/behavioral.yml`.
//
// Print it for a shell: `bun tests/behavioral/_probe-target-skips.mjs`

export const PROBE_TARGET_SKIPS = [
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
  // against a hosted-demo deployment: HOSTED_DEMO_CHECKS, below, which
  // `bun run staging:deploy` runs against nimbus-staging.
  //
  // This one is skipped for a capability that was ALREADY invisible once
  // — unreachable on production for weeks because nothing asserted the
  // landing page offered it. So its landing-page half is duplicated as a
  // hard assertion in `tests/unit/hosted-demo-anon-session.mjs`, which
  // runs on every target and cannot be skipped by a target's shape. If
  // that unit assertion is ever removed, this skip becomes a blind spot
  // again.
  'auth/new/hosted-demo-anon-launch',
  // Host-form previews (`<port>--<sid>.<suffix>`) need a zone route with
  // NIMBUS_PREVIEW_HOST_SUFFIX, which only production has; a probe target
  // serves path-form previews only. The promotion runs it on production, and
  // coi-isolated-preview covers the same isolation in the path form here.
  'preview/new/coi-host-preview-live',
  // The docs' live terminal and the /try terminal in a browser: the probe
  // target serves neither. Run against every hosted demo (HOSTED_DEMO_CHECKS).
  'docs/new/hosted-docs-terminal',
  'auth/new/hosted-demo-try-terminal',
];

/**
 * The checks a hosted demo gets as a visitor reaches it, anonymously:
 * release.mjs runs them against staging's demo, and promote.mjs against
 * production (remote-probes --target hosted:<origin>). The OAuth probes need
 * an interactive login and are not among them.
 */
export const HOSTED_DEMO_CHECKS = [
  'auth/new/hosted-demo-anon-launch',
  'auth/new/hosted-demo-try-terminal',
  'docs/new/hosted-docs-terminal',
];

/** What production alone can serve (host-form previews need its zone route): promote.mjs adds these. */
export const PRODUCTION_ONLY_CHECKS = ['preview/new/coi-host-preview-live'];

if (import.meta.main) process.stdout.write(PROBE_TARGET_SKIPS.join(','));
