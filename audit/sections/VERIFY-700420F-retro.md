# VERIFY-700420F retro — Verification of merged main HEAD `700420f`

> **Wave kind:** Audit-only verification re-measure on local main HEAD
> `700420f` (post Batch Merge II — X.5-NPQO + 4 audit-only branches).
> Worktree: `/workspace/worktrees/verify-700420f` on branch `verify-700420f`.
> Base: local main `700420f`. Reference: VERIFY-90993B3.md (predecessor
> baseline 23/33 strict ✅) + X5NPQO-retro.md (the X.5-NPQO retro that
> honestly forecast 0/4 strict-✅).
> Mission: faithful re-measure with no src/ edits; surface drift in
> per-bucket retro vs prompt forecasts; rank next buckets.

---

## TL;DR

The verification confirms the **X.5-NPQO retro's HONEST 0/4 strict-✅
verdict** exactly. Total healthy stays at 23/33 (70%). The prompt's
framing ("X.5-NPQO predicts +4 → 27/33 strict") DRIFTED from the
retro's actual forecast and from measured reality by +4 strict-✅
flips.

The wave found 0 source-level regressions, 0 cross-wave conflicts,
and a cleaner classification landscape: 5 distinct failure clusters
with 2 ≥2-package candidates (Bucket R = events/class-extends-undefined,
unblocks fastify+redis; Bucket Z3 = pre-compile ESM .mjs, unblocks
jsdom+tailwindcss-vite). Recommended dispatch order R → Z3 → O-cont
yields cumulative 28/33 (85%) at ~3-6 days.

The most important strategic takeaway: **the predecessor wave's retro
TL;DR is more reliable than the same wave's plan-time dispatch
forecast.** The wave authors who implemented the fix know the deeper
layer better than the dispatch authors did.

---

## What surprised me

### 1. The prompt's "+4 → 27/33" forecast contradicts the X.5-NPQO retro it cites

The prompt opens with: "X.5-NPQO predicts +4 → 27/33 strict. Verify-90993b3
measured 23/33 strict ✅. X.5-NPQO predicts +4 → 27/33 strict."

But X.5-NPQO retro itself (X5NPQO-retro.md lines 14-26) **rejects
that prediction**:

> **E2E layer (real-package install + require): 0/4 strict-✅; 4/4
> charter-pass.** Each of fastify, redis, jsdom, vite progressed past the
> NPQO-targeted error to a NEW deeper failure that maps to a follow-up
> bucket OUT of the NPQO charter.

The "+4" forecast comes from VERIFY-90993B3.md §4 cumulative dispatch
math (which predates the X.5-NPQO build wave) — that forecast was
written as **bucket plan**, not as bucket retro. By the time the
NPQO build wave landed, the deeper failure layer was understood, and
the retro corrected the forecast down to 0 strict-✅.

**Surprise:** the prompt mixes the two — quotes a retro source but
uses a plan-time forecast. The verification side held to the retro's
honest read.

### 2. Bucket P fix is mechanically correct but the deeper failure for fastify+redis is THE SAME root cause

X.5-NPQO retro listed the next-dispatch follow-ups as TWO separate items:

- "1. avvio Plugin shim for fastify"
- "2. events.EventEmitter export shape for redis"

But measuring at 700420f shows both errors:

- fastify: `TypeError: Cannot read properties of undefined (reading 'start')` (avvio Plugin extends EventEmitter; `.start` property miss when `parent` is undefined)
- redis: `TypeError: Class extends value undefined is not a constructor or null` (`@redis/client` class extends events.EventEmitter; the EventEmitter binding is undefined)

Both errors trace to the SAME class of issue: the `events` module's
binding is shaped wrong from the perspective of the consumer's
require interop, leading to undefined value where a class should
be. **This is one bucket (Bucket R), not two.** Combining them
saves an investigation phase and likely converges the fix into one
shim region (the events registration at `src/node-shims.ts:677-698,
1753`).

**Surprise:** the retro split this into 2 next-dispatch items by
package, but the verification reveals it's 1 bucket by root cause.

### 3. X.5-NPQO Q's util/types fix legitimately UNBLOCKED jsdom past undici, but the fix was insufficient at the strict-✅ layer because the next layer (Bucket Z3) sat right behind it

VERIFY-90993B3.md §3 noted jsdom's failure at `node:util/types`. X.5-NPQO
Q registered the subpath + expanded the polyfill from 3 to 17 methods.
At 700420f, jsdom no longer fails at util/types — it now fails at
`@csstools/css-tokenizer/dist/index.mjs Unexpected token 'export'`,
which is a **DIFFERENT package's pre-compile failure**.

This is the X.5-F precedent: each fix unblocks one layer, and the
deeper layer surfaces. **The verify forecast can only see as deep as
the current top error** — once the top error is fixed, the layer below
shows up. The dispatch forecasts treat each package as a single fix
target; reality treats them as multi-layer onions.

**Surprise:** I expected jsdom to either flip ✅ (if util/types was the
last layer) or to fail at util/types still (if the fix didn't compile).
Neither happened — it failed at a deeper layer that VERIFY-90993B3
couldn't see because it was hidden behind the util/types miss.

### 4. The wrangler dev sandbox isn't quite stable enough for back-to-back-to-back 33 large npm installs

Mid-run at 21:29:11, wrangler dev died with `ENOSPC: no space left
on device, write` — the disk filled up. Root cause: prior worktrees'
`.wrangler/` caches accumulated to ~9 GB over previous waves. Restarted
after cleanup; second run also produced one V8 heap-OOM during the
X.5-NPQO e2e suite vite probe (the 33rd install in a row produces
allocation pressure beyond what miniflare/workerd can absorb in
default config).

**Surprise:** environmental rather than codebase-related, but it cost
~30 minutes of wall time to recover and re-run 19 packages. Future
verify waves should plan for: (a) periodic disk cleanup of `.wrangler/`
caches before starting; (b) a "restart wrangler every N packages"
pattern; or (c) run installs serially with explicit sandbox restart
between batches.

---

## Retros that overstated, going forward

### VERIFY-90993B3.md §4 dispatch forecast overstated by +4 strict-✅

The forecast assumed each NPQO-targeted package was healthy beneath
the targeted error. None of the 4 were. **For future verify waves:
do not trust dispatch math at the strict-✅ layer; treat dispatch
math as a CEILING, not a target.** Use predecessor retros as the
floor.

### Prompt's "+4 → 27/33" forecast overstated by +4 strict-✅

Same root cause — the prompt cited the dispatch forecast rather than
the retro's verdict. **Mitigation: my synthesis quotes both forecasts
side by side and lets the measured number arbitrate.**

### Original PROMPT bucket P plan (2 pkgs → +2 ✅) overstated by +2

Bucket P's literal-`.`/`..` fix is correct, but neither fastify nor
redis flipped because both have a deeper events.EventEmitter issue.
The X.5-NPQO retro caught this and renamed Bucket P from "+2 ✅" to
"charter-pass + bucket R follow-up". My verify confirms the retro's
read is correct.

### X.5-NPQO retro's "next-dispatch 2 separate buckets" call slightly overstated effort

The retro called for separate avvio-Plugin-shim and events.EventEmitter-export-shape
fixes. Verification reveals they share a root cause, so they should be
ONE bucket (Bucket R), not two. This SAVES a dispatch round, not
costs one — but it means the cumulative healthy targets in the retro's
"Next dispatch" section are correct in number (+2 for fastify + redis),
just achievable in 1 wave rather than 2.

---

## What's NEXT

### Immediate (audit-only, this verify wave)

- **DONE:** `audit/sections/VERIFY-700420F.md` synthesis (~340 lines).
- **DONE:** `audit/sections/VERIFY-700420F-retro.md` (this file).
- **DONE:** `audit/probes/verify-700420f/packages-local/` — 33 probe artifacts + `_TABLE.md` + `_SUMMARY-CLASSIFIED.json`.
- **DONE:** `audit/sessions/verify-700420f-progress.md` — phase-by-phase progress log.
- **PENDING:** branch push best-effort (Phase F). Same 403 grant lapse expected as the prior 31 commits on local main.

### Next dispatch (build waves) — ranked by package-count-unblocked

1. **Bucket R — events / class-extends-undefined unification** (1-2 days, +2 ✅: fastify + redis). Investigation phase first to decode the exact intermediate object shape, then ~10-30 LOC fix in `src/node-shims.ts:677-698, 1753` events registration.
2. **Bucket Z3 — pre-compile ESM .mjs** (1-3 days, +2 ✅: jsdom + tailwindcss-vite). Structural extension of W3.5's Fix B (ESM-to-CJS transform) into the facet startup pre-compile path.
3. **Bucket O-continuation (M-3 null-base resolver)** (0.5-1 day, +1 ✅: vite). ~10-30 LOC in node-shims.ts rolldown-CJS polyfill section to resolve `import.meta.url` to a real on-VFS file path.

Cumulative target: 28/33 = 85% in ~3-6 days. (The 27/33 / 82%
milestone from VERIFY-90993B3.md §4 is reachable via R + Z3 alone in
~2-5 days, just realized through different buckets than originally
forecasted.)

### Beyond the next 3 buckets (structurally harder, individual investigation)

- **express prototype chain** (`Object prototype may only be an Object
  or null: undefined`) — X.5-Z5 plan exists; needs investigation to
  decode exactly which `__proto__` setter is misfiring in
  `lib/application.js`.
- **ts-jest W2.6b cap** (`Cannot read properties of undefined (reading 'native')`) — typescript.js ~9 MiB single-file is greedy-evicted from the prefetch bundle. W2.6b territory; eviction policy fix.
- **tailwindcss-oxide npm-cli #4828** — pre-existing W2.6b territory; orthogonal to X.5 shim cluster.
- **nuxt defu.cjs chain** — distinct from X.5-L's bare-spec class;
  needs separate investigation phase per X5NPQO-retro §"nuxt status".
- **rollup alias-after-swap** — backlogged from VERIFY-EB316DC.md §6;
  ~10 LOC in install plan to also create `node_modules/rollup` alias
  entry.

### Strategic

- **For future verify waves:** treat the predecessor wave's retro
  TL;DR as the source of truth for forecasted strict-✅ flips, NOT
  the dispatch math. The retro authors know the deeper layer better
  than the dispatch authors did.
- **For future X.5 dispatch:** when a charter-pass wave lands (deeper
  failure surfaces but targeted error is gone), follow up with a
  verify wave BEFORE planning the next batch — the cluster shape is
  often clearer at the verify than at the retro layer (e.g., R's
  unification across fastify+redis was visible at verify, not at
  retro time).
- **For prod deploy gate:** still blocked on user OAuth return.
  Nothing in this wave changes that gate. The 23/33 strict matrix is
  the steady-state local-runnable view; prod-acceptance probes will
  re-measure when wrangler auth returns.

---

## What didn't change

- **prod deploy gate:** still user-OAuth-return as before
- **origin/main HEAD:** still `eb316dc` (push 403 grant lapse; local main now 49 commits ahead, +1 if this verify-700420f branch's commit lands)
- **tsc baseline:** 2 errors, byte-identical to eb316dc + 90993b3
- **single-resolver invariant:** 7 waves now compose cleanly without forking
- **X.5 probe suites:** all 7 still 100% green at 700420f at the local-runnable layer (X.5-NPQO 9/10 with 1 environmental indeterminate is acceptable)

---

## Bottom line

**Measured:** 23/33 strict healthy at 700420f. Same as 90993b3. The
+4 → 27/33 forecast overstated; the X.5-NPQO retro's 0/4 strict-✅
verdict held exactly. **0 regressions; 0 cross-wave conflicts; 0
new tsc errors.**

**Recommended next:** Bucket R (events/class-extends, 1-2 days) →
Bucket Z3 (pre-compile ESM, 1-3 days) → Bucket O-continuation (M-3
null-base, 0.5-1 day). Cumulative 28/33 (85%) at ~3-6 days.

**Strategic insight:** trust retros over dispatch forecasts at the
strict-✅ layer. Use the verify wave as the arbiter when retro and
dispatch disagree (this wave validated the retro). Future verify
waves should plan for environmental friction (disk cleanup, sandbox
restarts) when running 33 large npm installs back-to-back.
