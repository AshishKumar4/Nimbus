# PROD-RESET-RESEARCH — Synthesis (R7)

This file pulls R1-R6 together to answer the user's R7 question:

> with R1-R6 evidence: is "supervisor at 64 MiB" right or should we
> SHED supervisor and orchestrate peer DOs each at full 128? Existing
> facet pool fundamentally limited or just under-leveraged? IDEAL
> DO/facet topology for npm install + pre-bundle + preview? Smart
> Placement + read-replicas → truly parallel install (one DO per
> package, deterministic merge)?

The previous plan §3 (drafted before this research) made several
implicit assumptions that R1-R6 contradicts. Synthesis reframes
the architectural choices in light of public-platform evidence.

---

## §S.1 The three platform facts that change everything

**Fact 1 (R1.1)**: 128 MB is per-V8-isolate, NOT per-DO. Same-class
peer DOs MAY co-tenant in one isolate, sharing 128 MB. Spawning
N peer NimbusSession DOs does not give us N × 128 MB ceiling.

**Fact 2 (R6.4)**: DOs are evicted **1-2× per day** by routine
runtime restarts, regardless of memory pressure. Recovery
correctness is platform-required, not optional.

**Fact 3 (R5.2-R5.4)**: Cloudflare Containers exist as a GA
primitive with 256 MiB-12 GiB+ memory per instance, fronted by a
DO. This trivially solves Bug C's memory-pressure trigger but
constitutes a product pivot.

These three facts, in combination, settle every architectural
question the previous plan §3 was hedging on.

---

## §S.2 Re-answering the user's R7 questions

### §S.2.1 "Supervisor at 64 MiB right, or shed supervisor and use peer DOs?"

**Neither, as previously framed.**

- Spawning peer DOs of `NimbusSession` class for parallelism FAILS
  (Fact 1). They co-tenant.
- Spawning peer DOs of a NEW class (e.g. `PreBundleDO`,
  `NpmInstallDO`) WORKS for cross-class isolation but cross-DO
  RPC has cross-region RTT (R4.6). Bad for tightly-coupled
  workloads.
- Sharding work across DOs is the wrong axis. The right axis is
  **dynamic Workers (LOADER.get) within ONE DO**. Each loaded
  Worker is its own V8 isolate with its own 128 MB (R2.2). Same
  data center as the supervisor — zero RPC latency. ~5-6
  concurrent isolates per supervisor (R2.3).

**Verdict**: keep supervisor minimal (Track A' shape from previous
plan §3 was correct), fan to dynamic Workers in same DO. The
"64 MiB ceiling" target was reasonable but the right metric is
"supervisor never holds bulk allocations >1 MiB", not a fixed
heap target. Once that invariant holds, the budget is whatever
the runtime gives us.

### §S.2.2 "Existing facet pool fundamentally limited or under-leveraged?"

**Under-leveraged**, with two specific gaps:

- ❗ Per-spec-ID fan-out (R2.5): today's pool uses ONE LOADER ID
  with `pLimit(N)` inside it. The platform allows DIFFERENT IDs
  to land in DIFFERENT isolates with ~5-6 parallel ceiling. We
  could split N specs into N stubs instead of N concurrency-
  limited inner calls.
- ❗ Slice transit (Track A'.2): today the supervisor owns the
  slice bytes (28 MiB per spec). With ReadableStream-over-RPC
  (R3.6) we can stream from supervisor to facet without holding
  the whole slice in supervisor heap.

Both are under-leveraging the platform, not platform limits.

### §S.2.3 "IDEAL topology for npm install + pre-bundle + preview?"

| Workload | Topology | Reasoning |
|---|---|---|
| **npm resolve** | Single dynamic Worker invocation, batched | 15-package resolve fits in 128 MiB easily. Single LOADER.get isolate. Zero supervisor heap touch. Already correct in current code. |
| **npm install (fetch+materialize)** | Single batch-facet (current). For >50 packages, split into chunks of ≤32 service-binding invocations per request (R6.5). | Tarball fetches stream into the facet. Supervisor never holds bytes. |
| **Pre-bundle** | N parallel dynamic Workers, ID = `prebundle:<spec>:<sliceHash>`. Slice bytes streamed from supervisor via ReadableStream. | Per-spec parallelism = R2.5 platform-level multi-isolate. Each spec in own 128 MiB. Up to ~5-6 in flight at once. |
| **Vite dev server** | Single dynamic Worker (`cirrus-real`), long-lived via `LOADER.get(id, ...)`. State in DO SQLite (Track B'). | Same-isolate transforms (current cirrus-real). Eviction-resilient via Track B' rehydrate. |
| **Preview iframe / HMR** | Same as vite dev server (the cirrus-real facet handles HMR routing). | Already correct. |
| **Shell + Kernel** | In-supervisor (no facet). Track B'-backed for state. | Shell input/output is small; supervisor heap touch trivial. The kernel is the supervisor's "control plane". |

This is just a sharper articulation of plan §3 Track A'. Research
confirms the shape; under-leveraged points named above.

### §S.2.4 "Smart Placement + read-replicas → truly parallel install (one DO per package, deterministic merge)?"

**No.**

- Smart Placement is single-location latency hiding (R4.3). Not
  parallelism. Ignored for RPC.
- Read replicas serve READ traffic only (R4.4). Writes go to the
  primary. Not a parallelism mechanism for write-heavy workloads.
- "One DO per package" runs into Fact 1 — same-class peer DOs may
  co-tenant. AND cross-DO RPC adds latency (R4.6).

Multi-region parallelism is the wrong axis for npm install. The
right axis is multi-isolate-within-one-region (R2.5 / dynamic
Workers).

---

## §S.3 Top-3 architecture-impacting findings

Listed by descending impact on plan §3.

### Top-1 — DO eviction is 1-2× per day baseline (R6.4)

**Source**: [Agents — Durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/) §"Why fibers exist".

> Durable Objects get evicted for three reasons:
> 1. Inactivity timeout — ~70-140 seconds with no incoming requests
>    or open WebSockets
> 2. **Code updates / runtime restarts — non-deterministic, 1-2×
>    per day**
> 3. Alarm handler timeout — 15 minutes

**Impact**: Track B' (state persistence + recovery correctness) is
**not optional**. It's a platform-required correctness property.
Even with perfect Track A' (memory pressure eliminated), eviction
WILL happen daily.

The previous plan §3 framed B' as "blast-radius mitigation". Wrong
framing. R6.4 reframes B' as "the platform mandates this".

### Top-2 — `runFiber` / `stash` / `onFiberRecovered` is the platform-blessed Track B' pattern (R6.4)

**Source**: [Agents — Durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/) example.

The Agents framework's fiber primitive is exactly Track B' as a
platform-blessed pattern:
- `runFiber('task', cb)` registers a long-lived task in SQL.
- `ctx.stash({...})` checkpoints intermediate state to SQL.
- On DO recovery, `onFiberRecovered(ctx)` runs with the snapshot.

**Impact**: Track B' has a known-good design source. Plan §3's
sketched "Phase R / B / W / O" design should be replaced with
"adopt or reimplement the fiber primitive". Specifically:
- Long-running shell commands (`npm install`, `npm run dev`) are
  fibers.
- Vite dev server is a fiber.
- Cwd / scrollback / env are NOT fibers — they're regular state
  in supervisor SQL, recovered via `ctx.storage.sql` reads on
  next initSession invocation.

### Top-3 — Same-class peer DOs may co-tenant in one V8 isolate (R1.1)

**Source**: [DO Pricing footnote 5](https://developers.cloudflare.com/durable-objects/platform/pricing/).

> If your account creates many instances of a single Durable Object
> class, Durable Objects may run in the same isolate on the same
> physical machine and share the 128 MB of memory.

**Impact**: rules out "spawn peer NimbusSession DOs" as a
parallelism strategy. The right answer is dynamic Workers
(LOADER.get) inside one DO. The previous plan §3 didn't directly
propose peer-DO spawning but the user's R7 prompt listed it as
a candidate; this synthesis explicitly rules it out.

---

## §S.4 Are the original 5 review gates still right?

The previous plan §4.4 had 5 USER REVIEW POINTS. After R1-R6 each
either:

- **Settles** — research provides clear answer; no review needed.
- **Stays** — research doesn't bear on it; user judgment still
  required.
- **Opens** — research raises new questions or reframes the gate.

| Original gate | Status | Reasoning |
|---|---|---|
| **Gate 1** Bug B fix approach: heap estimator vs `process.memoryUsage()` | **STAYS** but refined | R5.4 confirmed DO 128 MB is JS heap only. R1.4 left "does SQLite page cache count?" UNVERIFIED. Plan §3 should still propose the deterministic estimator approach (Bug B fix), but the gate is now narrower: confirm the estimator's calculation matches workerd's actual heap accounting (testable post-fix). |
| **Gate 2** Remove supervisor resolver fallback path | **OPENS / RECASTS** | The previous gate was "is removal acceptable risk". R1+R2 reveal the deeper issue: the resolver in supervisor heap is one of multiple supervisor-heap-bulk-allocation sources. Gate becomes "approve the broader Track A' invariant: supervisor never holds >1 MiB". Removing the fallback path is one consequence; there are others (slice walker, esbuild bytes, etc.). User confirms the BROADER invariant. |
| **Gate 3** Default cirrus-real, deprecate in-supervisor vite | **STAYS** | R3.5 confirms cirrus-real architecture (in-facet vite) is the right shape; deprecation has BEHAVIOURAL impact (HMR, asset routing). Still needs user judgment. |
| **Gate 4** Replace `/ws` 409 with join-session path | **STAYS** | R6 didn't bear on this UX choice. User judgment still required. |
| **Gate 5** 64 MiB peak-heap ceiling vs 128 MiB cap | **SETTLES — DROPS** | R6.4 (1-2×/day eviction baseline) means even a perfect 64 MiB ceiling won't prevent daily resets. The right metric is "supervisor never holds bulk allocations" + "Track B' makes recovery correct", not a numeric ceiling. Drop this gate. |

**NEW gates from R1-R6**:

| New gate | Reason from research |
|---|---|
| **G6** Adopt Agents `runFiber` primitive directly, OR reimplement in Nimbus | R6.4 — the platform has a blessed pattern. Adopting vs reimplementing is a design + dependency choice. |
| **G7** Workflows-style `step.do()` for npm install / pre-bundle | R6.3 — alternative to fibers for this use case. Tradeoffs: Workflows are a separate primitive with its own billing; fibers are inside the DO. User chooses. |
| **G8** Per-spec-ID dynamic-Worker fan-out for pre-bundle | R2.5 — under-leveraged platform parallelism. Tradeoff: more complex orchestration vs better isolation. User confirms. |
| **G9** Container migration as alternative architecture (NOT in this round) | R5.7 — explicit "for the record, this exists". User confirms we are NOT pursuing this. |

So: 3 gates settle/drop, 4 stay (refined), 4 new gates added.

Total: 8 gates after research, vs 5 before. The new gates are
narrower and better-grounded.

---

## §S.5 Recommended NEW first build dispatch

The previous plan §4 dispatch order was:

```
Bug B fix → C'.1 + C'.2 → interactive-liveness probes → A' / B' parallel → cross-track verification
```

With R6.4 elevating Track B' to "platform-required correctness",
the dispatch order should change:

```
Bug B fix          (≤60 LOC, prereq for verification)
  ↓
C'.1 heap estimator + C'.2 recovery_event schema (≤200 LOC combined)
  ↓
interactive-liveness probes (3 components, ≤600 LOC total, no src/ change)
  ↓
PARALLEL:
  A'.* memory containment (5 sub-changes, ≤200 LOC each)
  B'.* state persistence + fiber-style recovery (5 sub-changes,
       leveraging Agents `runFiber` pattern, ≤300 LOC each)
  ↓
Cross-track verification + retro
```

The change from previous plan §4: explicit reference to fiber
primitive in B'; explicit "containers not pursued" in §5.

**Recommended NEW first build dispatch**: Bug B fix.

Specifically:
- Replace `readSupervisorHeap` (`src/npm-installer.ts:1936-1945`) with
  a deterministic estimator function that sums known-allocation
  sources. The function lives in `src/heap-estimate.ts` (new file).
- Source the constants from existing code (e.g. SLICE_CAP_BYTES,
  PRE_BUNDLE_CONCURRENCY).
- Validate against `diag-counters.ts` aggregates within ±10 %.
- Surface as `peakHeapEstimate` in `/api/_diag/memory` v3.

≤60 LOC. Smallest dispatchable unit. Zero behavioural change. After
this lands, all subsequent waves can MEASURE their effect.

Gate 1 is required before this dispatch goes — user confirms the
"deterministic estimator" approach vs. trying again for real
`process.memoryUsage`.

---

## §S.6 Platform-gating discovered

Things that BLOCK Nimbus from doing certain architectural things,
even if we want to:

| Block | Source | Workaround |
|---|---|---|
| Same-class peer DOs may co-tenant 128 MB | R1.1 | Use cross-class DOs OR dynamic Workers |
| 32 service-binding invocations per request | R6.5 | Coalesce / batch / split across requests |
| 6 simultaneous open connections | R2.8 | Stack / queue beyond 6 |
| 32 MiB structured-clone RPC cap | R3.6 | ReadableStream-over-RPC |
| Smart Placement ignored for RPC | R4.3 | RPC always runs locally; design accordingly |
| `setHibernatableWebSocketEventTimeout` 5s default | R1.6 (existing) | Keep WS handlers <5 s; offload to facets |
| Workers Paid: 30s default CPU per request, configurable to 5 min | R1.2.2 + Workers Limits | Configure `limits.cpu_ms` for heavy DOs |
| DO eviction 1-2× per day | R6.4 | **No workaround — must be designed for** (Track B' / fiber primitive) |
| 128 MB DO heap cap | R1.1 | Container migration (R5) — declined for product reasons |

The last two are the architectural floors plan §3 must accept.

---

## §S.7 Confidence + open follow-ups

### High-confidence findings (architecturally lockable)

- ✓ DO 128 MB cap is per-isolate, may share across same-class peers.
- ✓ DO eviction baseline is 1-2× per day.
- ✓ Dynamic Workers each get own 128 MB; ~5-6 concurrent ceiling.
- ✓ Service binding fan-out cap 32/request.
- ✓ ReadableStream-over-RPC bypasses 32 MiB cap.
- ✓ Smart Placement is single-location; ignored for RPC.
- ✓ Read replicas serve READ-only; writes serialize at primary.
- ✓ Containers exist as alternative architecture; not pursued.
- ✓ Agents `runFiber` is the blessed eviction-recovery pattern.

### Medium-confidence (strongly implied, not explicitly documented)

- ⚠ DO Facets get own isolate (implied by architecture but not
  explicitly stated in public docs).
- ⚠ SQLite page cache vs 128 MB JS heap accounting.

### Low-confidence (carry to research follow-ups)

- ⚠ Specific "5-6 concurrent dynamic workers" cap mechanism. The
  empirical observation matches a "memory-pressure on the runtime
  process" explanation but no specific cap is documented.
- ⚠ Whether DO read replication is GA for custom DO classes (not
  just D1). Nimbus's W12 code treats it as flaky.
- ⚠ 30-second `waitUntil` cap interaction with unlimited-wall-time
  DO requests.

These don't block plan §3 from committing; they're things to
verify before specific design decisions depending on them.

---

## §S.8 Single-paragraph synthesis for the user

The research confirms plan §3's overall shape (Track A' memory
containment + Track B' recovery correctness + Track C' observability)
is correct, but **resets two important framings**: (1) Track B' is
mandatory not optional because DO eviction happens 1-2× per day
regardless of our memory pressure; (2) Track B's design pattern
should explicitly adopt or reimplement the Agents framework's
`runFiber` / `stash` / `onFiberRecovered` primitive, which is the
platform-blessed answer to "what state survives DO eviction". The
research also reveals that Cloudflare Containers exist as an
alternative architecture that would trivially solve Bug C's
memory-pressure trigger but constitutes a product pivot — not
pursued. The user's R7 question "should we shed the supervisor and
use peer DOs?" gets a no: same-class peer DOs may co-tenant
128 MB; the right axis is dynamic Workers (LOADER.get) inside one
DO with per-spec-ID parallelism (under-leveraged today). Three of
the previous five review gates settle or drop; four new ones open
in their place; net 8 gates after research vs 5 before. The
recommended NEW first build dispatch is Bug B fix (deterministic
heap estimator, ≤60 LOC) so that all subsequent waves can measure
their effect.

---

## §S.9 Post-dossier amendments (R10) — 2026-05-08T06:35Z

After this synthesis was committed, three authoritative internal CF
dossiers landed at `docs/research/`. They confirm most of §S.1-§S.8
and refine three claims. Full dossier delta at
`audit/sections/PROD-RESET-RESEARCH-DOSSIER-DELTA.md`. This §S.9
records the synthesis-level amendments only.

### §S.9.1 Top-3 findings — UPDATED with dossier sources

**Top-1 (was: DO eviction is 1-2×/day baseline)** — STAYS, with new
mandate. `cf-primitives-dossier.md:§6 invariant I3` adds:
> Stub forwarding lifetime ≤ introducer's request. Coordinator can't
> be a transient Worker if jobs outlive its request. Default to
> coordinator-as-DO.

Combined with R6.4's 1-2×/day eviction, the invariant becomes:
**any cross-request state HAS to be in DO storage**. Track B' was
correctly upgraded to platform-required in §6.3.

**Top-2 (was: `runFiber` primitive)** — REFINED. The dossiers don't
discuss `runFiber` (Agents-framework-specific). They DO mandate
"coordinator-as-DO + state in DO storage" which is the same
invariant. Plan §3 should **build the fiber primitive in Nimbus
directly** (gate G6 → option B). No agents-package dependency.

**Top-3 (was: same-class peer DOs may co-tenant)** — REPLACED.
Dossier-backed Top-3 is now: **Worker Loader is Open Beta with
active high-risk PSR** (`cf-internal-dossier.md:§9.5`). Tickets
RM-27238 (GA), REVIEW-14667 (PSR risk-high-risk), REVIEW-17120
(GA review), EW-9655/9656 (Dice abuse-detection). Build dispatches
should NOT lock numeric assumptions about Worker Loader (50-cap,
billing model) that may shift at GA.

The same-class-peer-DO co-tenanting fact (R1.1) is still true and
still rules out peer-DO parallelism, but it's a smaller finding
than the GA-gating one in production-readiness terms.

### §S.9.2 Facets-vs-Loaders boundary in Nimbus

**Verdict: MOSTLY CORRECT (4/5 subsystems).**

`cf-primitives-dossier.md:§7.3` fitness scorecard lets us audit each
Nimbus subsystem:

| Nimbus subsystem | Current primitive | Correct primitive | Verdict |
|---|---|---|---|
| `npm-resolve` | NimbusFacetPool (Worker Loader) | Worker Loader | ✓ |
| `npm-install batch-facet` | NimbusFacetPool (Worker Loader) | Worker Loader | ✓ |
| `pre-bundle` pool | NimbusFacetPool (Worker Loader) | Worker Loader | ✓ |
| `npm-tarball` streaming | Worker Loader | Worker Loader | ✓ |
| `cirrus-real` (vite dev) | NimbusFacetPool (Worker Loader) | **DO Facet** (`ctx.facets.get`) | ❗ CONFLATED |

`cirrus-real` has long-lived state (vite's dep cache, HMR client
state). Per the fitness scorecard, "stateful work with own SQLite"
is DO Facet territory. Track D'.1 migrates this; everything else
stays.

**Naming cleanup** (non-blocking): rename `NimbusFacetPool` →
`NimbusLoaderPool` in code. Today's name predates the public DO
Facets primitive and creates confusion when reading either the
plan or the platform docs.

### §S.9.3 Recommended NEW first build dispatch — UNCHANGED

Bug B fix (heap estimator, ≤60 LOC). Dossiers don't change this.
They DO add detail:

- `cf-internal-dossier.md:§9.2` lists 5 workerd eviction-reason
  labels: `lru`, `condemned`, `inactive`, `dynamic_worker`,
  `dynamic_worker_banned`. The estimator should align with these
  taxonomy labels.
- Worker Loader's Open Beta status (top-3 above) means the
  estimator should be conservative — production may tighten
  caps below the OSS defaults.

Gate 1 (heap estimator approach) must clear before this dispatch.

### §S.9.4 Platform-gating discovered (SHIPs we depend on)

Status as of 2026-05-08 per `cf-internal-dossier.md:§9.5`:

| Primitive | Status | Tickets |
|---|---|---|
| Named entrypoints / RPC | GA | — |
| Dispatch Namespaces | GA | — |
| DO Facets (`ctx.facets.get`) | GA-where-DOs-are | No production gate observed |
| **Worker Loader** | **Open Beta** | RM-27238 (GA in flight), REVIEW-14667 (risk-high-risk PSR Sprint-135), REVIEW-17120 (GA review Needs Triage), SHIP-13903/13904, EW-9655/9656 (Dice abuse-detection) |
| Container DOs | Open Beta / private beta | RM-24991 (DO-near-container PRD in flight) |

Nimbus is built on Worker Loader. The Open Beta status is the
biggest platform risk for plan §3 build dispatches.

### §S.9.5 Final dispatch order — UNCHANGED in shape, refined in detail

```
Bug B fix (≤60 LOC, gate 1)
  └→ surface 5 workerd eviction-reason labels
  ↓
C'.1 heap estimator + C'.2 recovery_event schema
  └→ both conservative pending Worker Loader GA
  ↓
interactive-liveness probe class (3 components)
  ↓
PARALLEL:
  A'.* — memory containment with refinements:
    • A'.1 stable LOADER IDs (per-day uniqueness billing)
    • A'.NEW.7 fan-out cap = min(50, 32) per request
    • A'.5 verify modules cap (WL-8 open question)
  B'.* — fiber primitive built in Nimbus (not agents dep)
  ↓
Track D'.1 — cirrus-real → DO Facet (after A'/B'/C' green)
  ↓
Cross-track verification + retro
```

D' is now ONE migration (cirrus-real), not five — pre-bundle / npm
install / npm-resolve correctly stay as Worker Loaders.

### §S.9.6 Single-paragraph synthesis for the user (final)

Three internal CF dossiers (~230 KB total at `docs/research/`)
ground the architectural plan. Verdict: **plan §3's overall shape
is correct**. Track A' (memory containment via dynamic Workers in
same DO) is right; Track B' (state in SQL with fiber primitive
built into Nimbus) is right and platform-mandated; Track C'
(observability with deterministic heap estimator) is right and
should align with workerd's 5 eviction-reason labels. Three
refinements: (1) `NimbusFacetPool` is misnamed — it's a Worker
Loader pool, not a DO Facets pool. 4 of 5 subsystems are in the
correct primitive; only `cirrus-real` is conflated and should
migrate to a real DO Facet (Track D'.1). (2) Per-spec-ID fan-out
caps are min(50 loader-cap, 32 fan-out cap) per request, with
stable IDs to amortise per-day uniqueness billing. (3) Worker
Loader is Open Beta with active high-risk PSR — build dispatches
should not lock numeric assumptions until GA. The recommended
first build dispatch is unchanged: Bug B fix (heap estimator,
≤60 LOC, gate 1 clears first). Gate matrix is unchanged at 9
gates after R10 (no new gates; G6 leans toward "build in Nimbus,
not agents dep"; G7 caps refined).
