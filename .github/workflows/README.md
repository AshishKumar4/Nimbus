# `.github/workflows/`

## `behavioral.yml`

Deploys the commit under test to its own throwaway Worker and runs
`tests/behavioral/run-all.mjs` against it. Probes are discovered
recursively under `tests/behavioral/` and run sequentially.

### What is under test

The commit. The job builds `dist` through the build/bundle/build fixpoint
and fails if that rebuild changed anything — a commit whose committed
`dist` does not match its `src` cannot be graded as though it did — then
deploys `apps/probe` under a per-run `nimbus-tw-ci-<run-id>-<attempt>` name,
asserts the active version id actually changed, and points `BASE` at the
result. Teardown deletes the throwaway and confirms it is gone.

This is worth stating because it was not always true. The job used to point
`BASE` at `nimbus-probe` and grade whatever was already deployed there.
Nothing deployed to it, so from 2026-07-24 onward every green run certified
a twelve-day-old deployment and the PR's code was never executed.

A throwaway rather than `nimbus-staging`, deliberately: two PRs sharing one
target would grade each other's code, which is the same defect with a
shorter fuse. `nimbus-staging` stays a stable pre-production for the
promote-to-prod runbook (AGENTS.md § Staging And Promote).

### Auth

- `CLOUDFLARE_API_TOKEN` (repo secret) — needed to deploy. Scopes: Workers
  Scripts:Edit, D1:Edit, Workers R2 Storage:Edit, Workers KV Storage:Edit.
  The job fails loudly when it is missing rather than falling back to a
  shared deployment.
- `CLOUDFLARE_ACCOUNT_ID` — pinned in the workflow's `env`.
- No shared signing secret. Each throwaway generates its own `JWT_SECRET`
  and the run mints a matching token, so no token outlives its Worker.

Hosted-demo-only probes and the expensive markflow probes are skipped via
`NIMBUS_PROBE_SKIP`, resolved from `tests/behavioral/_probe-target-skips.mjs`
— the same list `bun run staging:test` reads, so the two cannot drift.

### When does it run?

| Trigger | Mode |
|---------|------|
| Pull request → `main` | `--no-retry`; any RED is a RED |
| Push to `main` | Retry-on-banner (matches local-dev semantics) |
| Manual `workflow_dispatch` | Same strict mode as a PR |

A PR push cancels in-flight runs for the same ref (concurrency
`cancel-in-progress`). Latest commit always wins. A cancelled run may not
reach teardown; `bun tests/behavioral/_throwaway-target.mjs list` finds any
`nimbus-tw-ci-*` strays, and `down --name <n>` removes them.

### Reading the output

Each probe logs one line: `[probe-name] ... PASS (3.2s)` or `[probe-name] ... FAIL (45.1s)`. Failed probes' tail lines are echoed inline. Summary line at end: `──── N pass / M fail (X retried) (total Ys)`.

Full run log uploaded as an artifact (`behavioral-log-<event>-<run-id>`) on
every run, retained 90 days.

### Local reproduction

The workflow runs the same two commands you would:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>          # account pin, required

eval "$(bun tests/behavioral/_throwaway-target.mjs up)"   # exports BASE + NIMBUS_PROBE_TOKEN
bun tests/behavioral/run-all.mjs --no-retry              # CI PR mode
bun tests/behavioral/run-all.mjs                         # CI main mode

bun tests/behavioral/_throwaway-target.mjs session   # one session: {base, sessionId, token}
bun tests/behavioral/_throwaway-target.mjs down      # delete, and confirm it is gone
```

`up` rebuilds `dist` first — wrangler bundles `dist`, not `src`, and
`bundle:shims` reads `dist` too, so the order is build → bundle → build.
Pass `--no-build` when you know the bundle is current. Tokens default to a
3-hour TTL, long enough that a probe can always still `DELETE` the sessions
it created.

To narrow a run while debugging:

```bash
NIMBUS_PROBE_ONLY=astro-real,sveltekit-real bun tests/behavioral/run-all.mjs
```

For repeated verification of a change, and for the hosted-demo surfaces a
throwaway does not have, use staging instead: `bun run staging:deploy` then
`bun run staging:test`.

### Required-check setup (one-time, manual)

To make the job block merge:

1. Open [repo Settings → Branches](https://github.com/AshishKumar4/Nimbus/settings/branches).
2. Add a branch protection rule for `main`.
3. Under *Require status checks to pass before merging*, enable and add
   `behavioral` (the job name from `behavioral.yml`).
4. Save.

Until then the job runs and reports status but does not block merge.

### Maintenance

Adding a probe under `tests/behavioral/` needs no workflow change — the
runner discovers it recursively. `timeout-minutes: 120` covers a build, a
deploy and ~380 sequential probes; a large probe-count increase may need a
bump.
