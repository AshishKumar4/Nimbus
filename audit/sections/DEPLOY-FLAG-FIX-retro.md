# DEPLOY-FLAG-FIX retro

**Branch**: `deploy-flag-fix`
**Base**: `main` @ `36a7071` (cleanup-and-readme merge)
**Date**: 2026-05-08

## Symptom

`wrangler deploy` and `wrangler deploy -e production` rejected with
`[code: 10021]`:

- `experimental` flag rejected
- `replica_routing` flag rejected (production env only)

## Timing-window evidence

| Time (UTC) | SHA | Action | Result |
|---|---|---|---|
| 2026-05-08T19:19Z | `0f583938` | `wrangler deploy` | ✅ succeeded |
| 2026-05-08T21:43Z | `0f583938` | `wrangler deploy` (same SHA, same wrangler 4.80.0) | ❌ rejected with [code: 10021] |

Same wrangler.jsonc. Same wrangler binary. **2.5h gap.** This is a
server-side validator change — Cloudflare started enforcing
$experimental flag restrictions on our account in that window.

## Root cause

Both flags are tagged `$experimental` in the workerd compatibility-flag
registry (`src/workerd/io/compatibility-date.capnp`):

```capnp
workerdExperimental @24 :Bool
    $compatEnableFlag("experimental")
    $experimental;
# Experimental, do not use.
# This is a catch-all compatibility flag for experimental development...

replicaRouting @60 :Bool
    $compatEnableFlag("replica_routing")
    $experimental;
# Enables routing to a replica on the client-side.
```

Per the same file's `experimental` annotation comment:

> **Experimental flags cannot be used in Workers deployed on
> Cloudflare except by test accounts belonging to Cloudflare team
> members.**

Cloudflare's deploy validator enforces this server-side. The 2.5h
window between the two deploys was when that enforcement turned on
for our account.

This is also documented in the public Compat Flags page
(https://developers.cloudflare.com/workers/configuration/compatibility-flags/) —
neither `experimental` nor `replica_routing` appears in the public
flag-history list, only in the workerd source.

## Runtime evidence per flag

### `experimental`

| Question | Answer |
|---|---|
| Does Nimbus runtime depend on this flag? | **No** |
| Does Nimbus set `allowExperimental: true` anywhere? | No (verified: `grep -rn "allowExperimental" src/` finds zero call sites; only `src/loaders/vendor/types.ts:25` declares the field for type-shape parity with cloudflare-parallel) |
| Does ctx.exports work without it? | Yes — `enable_ctx_exports` is implied by the `compatibility_date: 2026-04-01` setting (per public docs §"Enable ctx.exports", default 2025-11-17) |
| What did the wrangler.jsonc comment claim? | "ServiceStub serialization for WorkerEntrypoint-returning-WorkerEntrypoint patterns" — but the runtime evidence (src/session/bindings.ts:241-281) shows each "chained stub" is materialized via `ctx.exports.X({props})` not via stub-serialization |

**Verdict: dead config. Removing has zero runtime impact.**

### `replica_routing`

| Question | Answer |
|---|---|
| Does Nimbus runtime depend on this flag? | **No, has graceful-degrade** |
| Where's the graceful-degrade? | `src/replica/routing.ts::tryEnableReplicas` probes `ctx.storage.enableReplicas` and `ctx.storage.configureReadReplication`; both throw or return undefined when the platform-side feature is unavailable; probe catches and returns `state: 'unsupported'` |
| What does the runtime look like without the flag? | `replica.state = 'unsupported'`, DO falls back to single-primary path (verified locally on this branch — see /api/_diag/memory output below) |
| Was the risk anticipated? | Yes — `audit/sections/W12-plan.md:452` (R1): "flag rejected by prod runtime → Graceful-degrade: probe at runtime; log 'unsupported'. No user-visible breakage." |

Local verification (this branch, post-fix):

```json
GET /s/<sid>/api/_diag/memory → { ..., replica: {
    "state": "unsupported",
    "error": null,
    "isReplica": false,
    "bookmark": null,
    "suspended": false
} }
```

DO is alive, /api/_diag/memory returns 200 with full breakdown,
replica state correctly reports `unsupported`.

**Verdict: graceful-degrade works. Removing is the intended outcome
when the platform doesn't support the feature for this account.**

## Fix

`wrangler.jsonc`:

```diff
- "compatibility_flags": ["nodejs_compat", "experimental"],
+ "compatibility_flags": ["nodejs_compat"],
  ...
  "env": {
    "production": {
-     "compatibility_flags": ["nodejs_compat", "experimental", "replica_routing"],
+     "compatibility_flags": ["nodejs_compat"],
+     "worker_loaders": [{ "binding": "LOADER" }],   // wrangler dry-run
                                                     // warned this was missing
      ...
    }
  }
```

The CWB-1 hotfix (2026-05-05) had moved `replica_routing` from
top-level to env.production overlay so local `wrangler dev` could
run without it. With the platform now also rejecting it, the env
overlay's compatibility_flags collapses to be identical to top-level.
The env block remains for non-inheritable bindings (durable_objects,
r2_buckets, worker_loaders, vars).

## Runtime invariants preserved

- ✅ `ctx.exports` Service Bindings continue to work — implied by
  compat_date 2026-04-01 (enable_ctx_exports default).
- ✅ NimbusLoaderRPC.load() / .get() still work — they materialize
  child stubs via `ctxExports.NimbusLoadedWorker({props})`, not via
  stub serialization.
- ✅ DO read replicas graceful-degrade — `replica.state = 'unsupported'`
  in /api/_diag/memory output. Single-primary path still serves all
  traffic; W12 functional probes 8/8 PASS.
- ✅ tsc baseline 2 errors (unchanged from main).
- ✅ Phase 5 regression: 29/29 PASS, 139 PASS lines (28 prior + the
  new deploy-validation probe).

## Probe added

`audit/probes/deploy-validation/no-experimental-flags.mjs`:

A pre-flight probe that asserts wrangler.jsonc compatibility_flags
contain none of the known $experimental flags from workerd. The
known-experimental list is hard-coded (12 entries as of 2026-05-08)
and matches workerd's `$experimental`-annotated flags. Adding a flag
to the known list catches a future breaking deploy at the probe
layer — wrangler dry-run won't catch it because that's
client-side; the platform-side validator is the only authority.

The probe also locks the structural invariant that env.production
preserves its non-inheritable bindings (would break prod if a future
PR collapsed the env block when only compat_flags differed).

Wired into `audit/probes/phase5-regression/run-all.mjs` so the full
regression run (29 probes total now) exercises it on every check.

## Verification status

- [x] tsc baseline preserved (2 errors)
- [x] `bun x wrangler deploy --dry-run` clean (no warnings, all bindings present)
- [x] `bun x wrangler deploy --dry-run -e production` clean
- [x] Local wrangler dev boots (was previously broken by the same
      flag — CWB-1 hotfix had hidden it but the root issue is the
      same)
- [x] /api/_diag/memory returns 200 with replica.state='unsupported'
- [x] Phase 5 regression: 29/29 PASS
- [x] W12 functional probes (8): 8/8 PASS (2 had stale paths post-
      cleanup-merge — replica-metadata-flag-in-diag and
      smart-placement-config-shape — fixed in this branch)
- [x] deploy-validation/no-experimental-flags: 9/9 PASS

The actual prod deploy (`wrangler deploy -e production`) requires
Cloudflare credentials that aren't available in this sandbox. The
deploy command is what CI / the integrator runs after merge. The
dry-run clean state + runtime invariants verified locally are the
strongest pre-deploy signal we can produce.

## Generated-file rebuild

`bun install` ran the postinstall scripts in this worktree. Two
generated files updated:

- `src/esbuild-wasm-bundle.generated.ts` — comment header now says
  "for use inside NimbusLoaderPool" (was "NimbusFacetPool"). The
  rename was already done in cleanup-and-readme; the generator
  template was updated then but the generated output hadn't been
  regenerated.
- `src/git-bundle.generated.ts` — timestamp bump.
- `src/loaders/generated-workers.ts` — timestamp bump.

These are downstream of script-template work that landed earlier;
including them keeps the source-of-truth aligned.

## Stuck file

None. The fix is single-config + verified runtime invariants. No
src/ behaviour change.
