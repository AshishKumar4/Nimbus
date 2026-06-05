# `.github/workflows/`

## `behavioral.yml`

Drives `tests/behavioral/run-all.mjs` against the live prod deployment
(`https://nimbus.ashishkmr472.workers.dev`). Discovers ~91 probes recursively
under `tests/behavioral/` (since TST-2) and runs each sequentially.

### When does it run?

| Trigger | Job | Mode |
|---------|-----|------|
| Pull request → `main` | `pr-strict` | `--no-retry`; any RED blocks merge if branch protection is configured (see below) |
| Push to `main` | `main-with-retry` | Retry-on-banner enabled (matches local-dev semantics); informational only |
| Manual `workflow_dispatch` | `pr-strict` | On-demand replay; same strict mode as PR |

A PR push cancels in-flight runs for the same ref (concurrency
`cancel-in-progress`). Latest commit always wins.

### Reading the output

Each probe logs one line: `[probe-name] ... PASS (3.2s)` or `[probe-name] ... FAIL (45.1s)`. Failed probes' tail lines are echoed inline. Summary line at end: `──── N pass / M fail (X retried) (total Ys)`.

Full run log uploaded as an artifact (`behavioral-log-pr-<N>` / `behavioral-log-main-<run-id>`) on every run, retained 30 days for PR runs, 90 days for main.

### Local reproduction

```bash
# Match the CI PR-strict mode (no retry, hits prod):
BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/run-all.mjs --no-retry

# Match the CI main mode (retry-on-banner):
BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/run-all.mjs

# Limit to a subset while debugging:
NIMBUS_PROBE_ONLY=astro-real,sveltekit-real \
  BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/run-all.mjs
```

### Required-check setup (one-time, manual)

To make `pr-strict` block merge:

1. Open [repo Settings → Branches](https://github.com/AshishKumar4/Nimbus/settings/branches).
2. Add a branch protection rule for `main`.
3. Under *Require status checks to pass before merging*, enable and add
   `PR-strict (no-retry)` (the job name from `behavioral.yml`).
4. Save.

Until step 1-4 is done, `pr-strict` runs and reports status but does NOT
block merge. The job's failure is visible on the PR but PRs can still
be merged manually.

### Sibling-deploy hazard

Prod can be clobbered by parallel `wrangler deploy` calls during a
behavioral run (the deploy-storm pattern documented across our recent
waves). The runner's `--no-retry` setting in PR mode makes this
visible: a clobber-induced flake counts as RED.

If you see a CI failure that "felt like" a flake, check:

1. `wrangler deployments list -e production` — was prod clobbered
   during the run window?
2. `behavioral-log-*` artifact's stderr — is it a known crash banner?
3. Re-run via *Re-run failed jobs* in the GH UI; if it passes, log
   the flake and consider whether the probe needs CLN-4 internal retry.

### Why hit prod, not a local server?

The Nimbus session is a deployed Cloudflare Worker + Durable Object —
spinning it up locally in CI would need wrangler auth, R2 buckets, DO
bindings, and matching node compat date. The prod deployment IS the
artifact we want to validate; the CI run is therefore a smoke-test of
the latest deployment plus the test-suite assertions against it. This
also means: **deploy first, then merge** when changes affect runtime
behaviour — the convention enforced by current ops practice.

### What CI does NOT do

- Deploy. Use `wrangler deploy -e production` locally.
- Run a local server. Use `bun run dev` locally.
- Run scheduled / cron checks. Separate wave if/when needed.
- Build artifacts. The behavioural suite consumes the deployed
  artifact directly.

### Maintenance

When adding a new probe under `tests/behavioral/`, no workflow change
is needed — the runner discovers it recursively. When the probe-count
or perf-regression threshold changes, the workflow's `timeout-minutes:
20` may need a bump.
