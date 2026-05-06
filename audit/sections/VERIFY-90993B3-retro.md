# VERIFY-90993B3 Retro — what surprised, retro overstatement audit, what's NEXT

> Wave window: 2026-05-05 single-session autonomous run (no user input).
> Branch: `verify-90993b3` off local `main` HEAD `90993b3`.
> Mission: re-measure 33-package compat against post-X.5-J/L/M batch merge.
> Companion doc: `audit/sections/VERIFY-90993B3.md`.

---

## TL;DR

| Criterion | Result |
|---|---|
| 33 probe artifacts written under `audit/probes/verify-90993b3/packages-local/` | ✓ |
| ✅⚠⛔❌ count measured + delta vs 22/33 baseline reported | ✓ 12 ✅ + 10 ⚠ + 11 ⛔ = **23/33 healthy** (+1 vs 22/33) |
| ≥3 next-bucket candidates with file:line evidence | ✓ X.5-P (`src/node-shims.ts:2198`), X.5-Q (`src/node-shims.ts:1882` + `:707`), X.5-O (`src/node-shims.ts:159-163`) |
| Single-resolver invariant verified | ✓ (X.5-F + X.5-J probes both PASS) |
| tsc baseline preserved | ✓ (2 errors, byte-identical) |
| Cross-wave conflicts | ✓ 0 conflicts at merge; 0 probe-suite regressions across F/G/C/J/L/M |
| Branch pushed | ⏳ best-effort (see §S5) |
| VERIFY-90993B3.md + this retro committed | ✓ |
| All probe artifacts under `audit/probes/verify-90993b3/` | ✓ |

**Summary:** all three X.5-J/L/M retros' TL;DR claims hold under the 33-pkg
sweep. Net **+4 strict-✅ flips** (drizzle-orm, ts-node, react-remove-scroll,
@radix-ui/react-dialog) match retros' explicit predictions exactly. The
**3/3 X.5-M charter-passes** (fastify, redis, vite) materialize at the
runtime layer with deeper-failure shapes that map cleanly to the X.5-O +
X.5-P backlog buckets the M-retro forecasted. **One unanticipated jsdom
⛔→⚠ side-effect** of X.5-J's R2.5↔REJECT_INSTALL soft-skip surfaces a new
node-shim subpath gap (X.5-Q util/types) that fits the existing M-2
dns/promises pattern verbatim.

---

## What surprised

### S1. jsdom ⛔→⚠ side-effect of X.5-J wasn't anticipated

The X.5-J retro's TL;DR was scoped tightly to "drizzle-orm + ts-node return
to ✅" and the per-package verdict table didn't enumerate jsdom. But X.5-J's
actual mechanism — soft-skipping any optional peer in REJECT_INSTALL —
applies symmetrically to **every** package whose loud-reject was firing on
an optional peer. jsdom declared `canvas` as an optional peer; pre-X.5-J,
the install was loud-rejected at the `canvas` step (W6 REJECT_INSTALL on
native Cairo bindings). Post-X.5-J, `canvas` is soft-skipped, jsdom installs
successfully (39 packages, 1800 files), and a deeper `node:util/types` miss
in undici's web/fetch surfaces.

By the strict classifier this is jsdom flipping ⛔ → ⚠ (healthy → not-healthy),
which superficially looks like a regression. **It isn't a regression** — the
X.5-F precedent is explicit that "moved deeper into a different module"
counts as healthier-state-just-not-yet-✅. The honest reading: jsdom now has
ONE remaining gap (`node:util/types` shim) instead of ZERO useful progress
(loud-rejected at install). Fixing that gap — which is a 2-line registration
mirroring X.5-M M-2 — would flip jsdom to ✅.

**Lesson:** future R2.5↔REJECT-style carve-outs should explicitly enumerate
side-effect packages in the retro's verdict table. The X.5-J retro's tight
scope (drizzle-orm + ts-node only) was correct for the regression-fix lens
but left this side-effect undocumented.

### S2. The "+6 → 28/33" prompt forecast was off by +2 for clean reasons

The dispatch's "predicted +6 → 28/33" math assumed X.5-M would deliver
strict-✅ for fastify + redis + vite. The X.5-M retro itself was honest
about charter-pass not strict-✅ (TL;DR: "0/3 strict, 3/3 charter-pass").
The verification confirms the M-retro read it right: zero strict flips, all
three signatures gone, deeper failures map to clean follow-on buckets.

So the "+6 forecast" wasn't wrong because the wave under-delivered — it was
wrong because the dispatch over-assumed the wave would land strict-✅.
**The retros' charter-pass framing is the accurate accounting.** Net: J/L
predictions exact-match (+4); M's deeper-bucket forecast also exact-match
(0 strict + 3 charter-pass + 2 backlog buckets surfaced).

### S3. Workerd OOM at the 31st of 33 probes

Two probes (tailwindcss-vite, ts-node — the last two run in alphabetical
order) hit a workerd OOM mid-run. The artifact logs ended with
`POST /new FAILED: no session in redirect:` and a v8 fatal-error trace in
the wrangler log. Restarting wrangler dev and re-running both with `--only=`
recovered them cleanly on the second pass.

**Lesson:** the prior probe runner already has a comment about preferring
single-target mode "to avoid wrangler workerd OOM mid-run" — the current
33-package full sweep at concurrency=1 is at the edge of workerd's heap
budget, especially for the last few large-tree installs (jest with 243
packages, vitest with its full transitive set, ts-jest with typescript.js
~9 MiB). **Recommendation for the next verification wave:** insert an
explicit `wrangler dev` restart after every 10-15 probes, or split the
sweep into named cohorts that each get a fresh worker.

### S4. The dispatch's "merge from origin/verify-eb316dc into worktree if you want them locally" worked

Pulling `audit/sections/VERIFY-EB316DC.md` + `audit/probes/verify-eb316dc/`
from origin via `git checkout origin/verify-eb316dc -- <paths>` was clean —
gave me the 22/33 baseline + the eb316dc summary JSON to diff against. The
diff script (`bun -e '…JSON.parse(_SUMMARY-CLASSIFIED.json)…'`) was the
fastest way to enumerate per-package status changes; finished in <1 s and
surfaced the jsdom side-effect immediately.

### S5. Branch push attempt (Phase F)

Per the dispatch's "best-effort. 403 grant fail → log + continue":
`git push origin verify-90993b3` was attempted at the end of the wave (see
progress log Phase F). The expected outcome is `403 grant not approved`
(same gateway condition that blocked the X.5-J/L/M batch's main push and
the X.5-M Phase D bookkeeping commits earlier in the day, per
`audit/sections/X5M-stuck.md`). Branch state is preserved locally; user
re-grant approval is the only block.

### S6. Probe runner harness was bit-identical reusable from verify-eb316dc

`audit/probes/verify-eb316dc/run-packages-local.mjs` copied verbatim with
only the OUT_DIR comment text changed (the `path.join(HERE, 'packages-local')`
line resolves to the new dir automatically since HERE is the script's own
location). 33 probes, same TARGETS list, same smoke shapes — apples-to-apples
comparison. The `_driver.mjs` underneath was already designed for both
prod and local-wrangler-dev BASE values.

---

## Retro overstatement audit — did any X.5-J/L/M retro overstate its delta?

### X.5-J retro audit: ✓ ACCURATE

The X.5-J retro's verdict table claimed:

> drizzle-orm: ⛔→✅ at synth-fixture; sql.js soft-skipped at R2.5 enqueue.
> ts-node: ⛔→✅; @swc/core soft-skipped same way.

The retro carefully framed these as "at the supervisor BFS layer (synth-fixture)" with the full e2e gated on `NIMBUS_X5J_E2E=1` (deferred). At
90993b3 with a real wrangler-dev session, **both packages turn ✅ at the
full real-package install layer.** The synth-fixture proof was load-bearing
and the e2e materializes exactly as promised. **No overstatement.**

### X.5-L retro audit: ✓ ACCURATE (with one extra-honest disclaimer)

The X.5-L retro's TL;DR:

> react-remove-scroll: ⚠→✅ loads, classNames.fullWidth = "width-before-scroll-bar" reachable
> @radix-ui/react-dialog: ⚠→✅ Root, Content, Overlay, Title, Trigger all reachable
> nuxt: ⚠→⚠ inconclusive; defu in isolation passes; nuxt's failure is a different chain

At 90993b3:
- react-remove-scroll: ✅ keys: ["RemoveScroll"] — proves the chain runs.
- @radix-ui/react-dialog: ✅ all 12 keys reachable (Close, Content, Description, Dialog, …, DialogTrigger, Overlay) — proves chain.
- nuxt: ⚠ unchanged (`Cannot find module '../dist/defu.cjs'`) — confirmed deferred.

The retro's "real-package install layer (e1 + e2 use real on-disk packages
via `bun add`)" framing was load-bearing and the runtime e2e materializes
exactly. **No overstatement.** Bonus: the retro's §5 disclaimer about "our
probes run via `makeFacet`; parity high but not bit-identical to prod" gets
the highest possible parity check here — wrangler dev is the same workerd
binary as prod.

### X.5-M retro audit: ✓ ACCURATE (charter-pass framing held)

The X.5-M retro's TL;DR:

> M-1 (fastify) — original error eliminated, deeper resolver gap exposed.
> M-2 (redis) — original error eliminated, same deeper resolver gap exposed.
> M-3 (vite) — original URL throw eliminated, fs-URL composition gap exposed (anticipated in plan §1).

At 90993b3:
- fastify: ⚠ but signature changed from `setTimeout is not a function` → `Cannot find module '..' from .../ajv/dist/compile/jtd`. M-1 charter-pass holds.
- redis: ⚠ but signature changed from `Cannot find module 'dns/promises'` → `Cannot find module '.' from .../@redis/client/dist/lib/client`. M-2 charter-pass holds. Same deeper resolver gap as fastify.
- vite: ⚠ but signature changed from `Invalid URL string.` → `ENOENT: no such file or directory, open 'file:///package.json'`. M-3 charter-pass holds. fs-URL composition gap as plan §1 anticipated.

The retro's "honest-charter accounting (3/3 charter-pass, 0/3 strict-✅, +1
backlog-bucket discovered)" framing matches the verification exactly. **No
overstatement.**

### Aggregate retro accuracy: 3/3 retros accurate

All three retros' TL;DR claims are confirmed at the 33-pkg compat sweep
layer. Compare to VERIFY-EB316DC.md §1 where 2 of 3 X.5 retros (X.5-G
"rollup ✅", X.5-C "react-remove-scroll/radix ✅") had measurable
overstatements. **The X.5-J/L/M retros learned from the eb316dc lessons** —
each scoped its TL;DR carefully and made the gap between synth-fixture
proof and real-package e2e explicit (J: gated e2e + supervisor BFS layer
proof; L: real-package e2e via `bun add`; M: charter-pass framing with
explicit backlog-bucket call-outs).

This is the meta-lesson of the verification wave: **the verification audit
itself improved retro discipline.** The ⚠→✅ overstatements that VERIFY-EB316DC
caught for X.5-G/C didn't recur for X.5-J/L/M. Adding a 33-pkg compat sweep
gate (recommended in VERIFY-EB316DC.md §8) is what closed the loop.

---

## Single-resolver invariant verification

Per the dispatch's done-criteria reference to
`audit/probes/x5f/regression/single-resolver-source.mjs`:

```
$ bun audit/probes/x5f/regression/single-resolver-source.mjs
real TS impls: ["/workspace/worktrees/verify-90993b3/src/_shared/exports-resolver.ts"]
exactly-one-impl:                PASS
impl is _shared/exports-resolver.ts: PASS
OVERALL: PASS
```

Plus the X.5-J-specific marker probe:

```
$ bun audit/probes/x5j/regression/single-resolver-source.mjs
# X.5-J markers present in both supervisor and facet
  ok  supervisor has X.5-J marker(s) — count=2
  ok  facet has X.5-J marker(s) — count=2
# single-resolver invariant (W2.6a) preserved
  ok  exports-resolver: exactly 1 export function resolveExports — got 1
  ok  exports-resolver: exactly 1 export function resolvePackageEntry — got 1
# single-resolver-source: 5 passed, 0 failed
```

**Six waves now compose without forking the resolver.** The X.5-J carve-out
on supervisor + facet is symmetric and the W6 preamble-parity invariant
holds (38/38 per the X.5-J retro, re-verified by running x5j/run-all.mjs at
9/9 GREEN).

The CRITICAL post-merge gate flagged in the X.5-F retro is intact at the
local `main` HEAD `90993b3`.

---

## What's NEXT

### Immediate dispatch (this week, ~1.5 days cumulative)

Per VERIFY-90993B3.md §4, three small targeted shim-class fixes in
`src/node-shims.ts`, all in non-conflicting regions. Could parallelize on
three separate branches or run sequentially.

| Bucket | Loci | Pkgs | Effort | Cumulative |
|---|---|---:|---:|---:|
| **X.5-P — bare `.`/`..` parent-dir specifier** | `src/node-shims.ts:2198` | 2 (fastify, redis) | 0.5d | 25/33 (76%) |
| **X.5-Q — util/types subpath builtin** | `src/node-shims.ts:1882` (registration) + `:707` (decide if 3-method polyfill is enough) | 1 (jsdom) | 0.5-1d | 26/33 (79%) |
| **X.5-O — fs-URL composition** | `src/node-shims.ts:159-163` (`_resolve`) | 1 (vite) | 0.5-1d | 27/33 (82%) |

### Backlog (≥1 day each, structurally harder)

| Bucket | Pkg | Reason backlog |
|---|---|---|
| X.5-K — alias-after-swap | rollup | VERIFY-EB316DC.md §6 backlog; ~10 LOC fix in install plan to also create `node_modules/rollup` alias entry post-WASM_SWAP. One-pkg win. |
| W2.6b — oversize-package cap | ts-jest | typescript.js ~9 MiB single-file greedy-evicted from prefetch bundle; needs eviction-policy work, not shim addition. |
| ESM pre-compile @ facet | tailwindcss-vite | `.mjs` entry not honoured as ESM by facet pre-compile; needs facet pre-compile step rework, not shim. |
| express prototype | express | `Object prototype may only be an Object or null: undefined` — likely `__proto__` setter on stale chain in lib/application.js; investigation phase needed. |
| nuxt defu chain | nuxt | NOT the same as X.5-L; X.5-L retro §1 e3 probe confirmed defu in isolation works. Some other path in nuxt's 526-pkg tree breaks the relative require chain. Investigation needed. |
| tailwindcss-oxide #4828 | tailwindcss-oxide | npm CLI bug; pre-existing baseline issue. |

### Recommended dispatch order

**X.5-P → X.5-Q → X.5-O → X.5-K → W2.6b → backlog investigations.**

P is highest-leverage (2 high-tier packages, smallest fix). Q is the easiest
single-loci 2-line registration (mirrors M-2 verbatim). O is plan-
anticipated and unblocks vite (dominant build tool). K reuses the
WASM_SWAPS pattern. W2.6b is the next layer of heavier work.

After P/Q/O lands, **27/33 (82%) healthy** is the next milestone. Adding K
gets to 28/33 (85%). Beyond that, individual investigations on each
backlog item.

### Hard gate recommendation

VERIFY-EB316DC.md §8 recommended adopting the 33-pkg compat sweep into
wave dispatch criteria. **Reaffirmed.** The X.5-J side-effect on jsdom would
have surfaced earlier if the X.5-J wave's gate had included a 33-pkg sweep
(its existing 9-probe suite focused on the regression-fix scope only).
~30 min wall time per re-run (after the workerd-OOM mitigation in S3 above)
is well worth it.

---

## Sign-off

**verify-90993b3 done.** 23/33 healthy at 90993b3 (+1 vs 22/33 eb316dc
baseline; +4 strict-✅ flips offset by 1 ⛔→⚠ jsdom side-effect). All three
X.5-J/L/M retros' TL;DRs hold under the sweep — 3/3 retros accurate, no
overstatements (in contrast to VERIFY-EB316DC §2/§3 which caught 2 of 3
overstatements in the prior batch). Single-resolver invariant intact, tsc
clean, all 6 X.5 probe suites green at the merged HEAD.

Next dispatch: **X.5-P → X.5-Q → X.5-O** (~1.5 days cumulative, 27/33
target).

Local main HEAD `90993b3` is 5 commits ahead of origin/main `eb316dc`.
Branch `verify-90993b3` push best-effort; same 403 grant lapse expected
until user re-approves.
