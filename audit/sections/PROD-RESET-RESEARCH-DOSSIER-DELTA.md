# PROD-RESET-RESEARCH — R10: Dossier-grounded plan re-evaluation

Three authoritative internal CF dossiers landed at `docs/research/`:

1. `cf-primitives-dossier.md` — executive synthesis + fitness scorecard.
2. `cloudflare-dynamic-primitives.md` — workerd OSS + public-docs deep dive.
3. `cf-internal-dossier.md` — internal Cloudflare GitLab/wiki/Jira deep dive.

This document re-evaluates Track A'/B'/C' against the dossiers as
PRIMARY SOURCE. Each finding is marked:

- ✓ CONFIRMED-by-dossier — public research had it right
- ❗ CONTRADICTED — dossier overrides our prior conclusion
- 🆕 NEW-OPTION-REVEALED — dossier surfaces an option not previously seen

Citation form: `docs/research/<file>:<section>` for relative refs;
external paths kept verbatim where the dossier cites GitLab/Confluence.

---

## §10.1 Track A' — re-evaluation against dossiers

### A'.0 framing — supervisor minimisation + dynamic-Worker fan-out

✓ **CONFIRMED-by-dossier**:

`docs/research/cf-primitives-dossier.md:§7` (fitness scorecard) ranks
**Worker Loader (named, warm)** at 5/5 for parallelism and 5/5 for
coordinator-friendliness. `cf-primitives-dossier.md:§1` calls it
"the centre of gravity ... for stateless fan-out".

`docs/research/cloudflare-dynamic-primitives.md:§7.3` recommends shape
1 (Ephemeral-loader pool) AND shape 2 (Persistent-thread pool via DO
facets) as the two primary multi-processing patterns. Both are
exactly what plan §3 Track A' is reaching for.

**Verdict on Track A'.0**: shape correct. Plan §3 framing of "supervisor
never holds bulk allocations >1 MiB" is the right invariant.

### A'.1 — eliminate supervisor resolver fallback path

✓ **CONFIRMED-by-dossier** that this is sound, with a refined cost
model:

`docs/research/cf-primitives-dossier.md:§6 invariant I10`:

> **Per-day Dynamic Worker uniqueness billing**: Use stable `id`s
> (e.g. hash of code) — each unique `id` per day is billed once.
> Mass-unique `id`s are a cost trap.

`cloudflare-dynamic-primitives.md:§1.7`:

> Anonymous (`load()` or `get(null, …)`) = 1 unique Worker per call.
> Scoping with stable `id` is the cost-saving default.

Implication for A'.1: when we move npm-resolver into a facet, the
LOADER ID must be **STABLE** (e.g. `npm-resolver:v1` based on
preamble hash), NOT per-package or per-request. Today's code at
`src/npm-installer.ts:560` (`new NimbusFacetPool(this.env, this.ctx!,
{...tag: 'pre-resolve'...})` uses a stable tag — ✓ correct already.
Document this invariant explicitly in A'.1.

### A'.2 — slice streaming via ReadableStream-over-RPC

✓ **CONFIRMED-by-dossier** + 🆕 **NEW-OPTION-REVEALED**:

`cloudflare-dynamic-primitives.md` confirms ReadableStream is
RPC-serialisable (R3.6 verified). 🆕 NEW: `cf-primitives-dossier.md:§6
invariant I11` reveals:

> **Loader env capabilities are rewritten on entry**: A coordinator
> can pass arbitrary RPC stubs into a loaded Worker — including a
> stub back to the coordinator. **This is the multi-processing
> primitive in disguise.**

So instead of "facet pulls bytes from supervisor via stream", the
even cleaner pattern is: **pass the supervisor stub itself into the
facet's `env`**, and the facet calls back via RPC with full
capability scoping. Already partly used by Nimbus's SupervisorRPC
plumbing.

For A'.2 specifically: continue with ReadableStream-over-RPC as
designed. The `env` capability injection is already handling the
authority side.

### A'.3 — synthesise barrels in facet (lucide-react etc.)

✓ **CONFIRMED-by-dossier** — same reasoning as A'.2. The facet has
its own 128 MB; transit those 3940 icon files via ReadableStream
in the facet's processing, not supervisor heap.

### A'.4 — deprecate in-supervisor vite, default cirrus-real

🆕 **NEW-OPTION-REVEALED**:

`cf-primitives-dossier.md:§2` and `cloudflare-dynamic-primitives.md:
§2.6` reveal that **DO Facets** (the public primitive
`this.ctx.facets.get`) provide **TRUE per-handler parallelism**:

> Within a single facet: standard DO single-threaded JS, input-gate-
> serialized handler invocation.
>
> **Across facets of the same supervisor: independent input gates →
> genuine parallel handler execution.** Storage isolation → no
> cross-facet locking from SQLite.

> **Parallelism ceiling**: all facets and the parent run in the same
> workerd process. Total CPU is bounded by the underlying machine's
> cores allocated to that DO instance.

Implication: cirrus-real today is a Nimbus-style facet (LOADER.get
+ WorkerEntrypoint). If we converted it to a public DO Facet
(LOADER.get + DurableObject + `ctx.facets.get`), we'd get:

- Independent input gate from supervisor — true parallel handler
  execution (transforms can run in parallel with shell input).
- Own SQLite database per facet — vite's dep cache gets its own
  storage stage without contending with supervisor SQL.
- Independent hibernation lifecycle.

For A'.4 itself (the "deprecate in-supervisor vite" gate), this
strengthens the case for cirrus-real. Adds a follow-up Track D' for
"convert cirrus-real to a public DO Facet" — covered in §10.4.

### A'.5 — esbuild-wasm bytes in R2, pulled from facet

✓ **CONFIRMED-by-dossier** as sound. No new constraint.

### A'.NEW.6 — yield-to-event-boundary on long supervisor bursts

✓ **CONFIRMED-by-dossier**:

`cf-internal-dossier.md:§9.7`:

> **Durable Object**: Single-threaded actor; explicitly
> "single-threaded on a single isolate." Concurrency from input/output
> gates and async I/O.

The 30-s-CPU-between-requests eviction risk (R1.2.2 / Workers Limits)
applies — if our supervisor's pre-bundle slot loop runs >30 s without
awaiting an inbound event, we risk eviction. A'.NEW.6 stays.

### A'.NEW.7 — per-spec-ID dynamic-Worker fan-out for pre-bundle

❗ **CONTRADICTED-by-dossier** — partial.

`cf-primitives-dossier.md:§6 invariant I1`:

> **Worker Loader: 50 isolates per owner per process LRU**: Hard
> ceiling on parallel "ephemeral threads" per process. To exceed,
> hash to a small set of stable `id`s OR multiplex multiple bindings
> OR fan out across DOs/colos.

`cloudflare-dynamic-primitives.md:§1.7` + `cf-internal-dossier.md:§9.1`:

> **Default 50 (`dynamicWorkersPerOwnerLimit @215 :UInt32 = 50`).**
> Configurable. Excess triggers LRU eviction.

So the platform DOES allow up to 50 isolates per owner per process —
that's much higher than my R2.3 estimate of "5-6 concurrent". The
empirical 5-6 we observed in Nimbus prod is likely memory-pressure
driven (the supervisor + each facet at ~80 MiB → ~6 fits in machine
budget) rather than the loader-cap.

🆕 **NEW-OPTION-REVEALED** by the same dossier section:
`cloudflare-dynamic-primitives.md:§7.3` invariant I10 + I15:

> **Per-day Dynamic Worker uniqueness billing**: Use **stable `id`s**
> (e.g. hash of code) — each unique `id` per day is billed once.
> Mass-unique `id`s are a cost trap.
>
> **Billing rolls up to the caller today** for facets and loaded
> workers. The whole loader-spawned tree bills as one logical script.

Implication for A'.NEW.7: per-spec-ID fan-out for pre-bundle would
generate a NEW unique-Worker-per-day for EACH spec encountered
across all sessions account-wide. With ~50 popular npm packages
across all users, that's 50/day extra unique Workers. Cost is
small but real.

**Verdict for A'.NEW.7**: still valid, but with two refinements:
1. Stable IDs based on `(specifier, sliceHash)` so the same package
   version is always one ID — caps the daily uniqueness count by
   the number of distinct package-version-pairs the install touches.
2. Cap concurrent fan-out at **min(50 loader-cap, 32 fan-out cap)** —
   the 32 fan-out cap (cf-primitives I2) is the binding limit per
   single supervisor request, not the 50 loader-cap.

### A' summary (re-evaluation)

| Item | Original verdict | Dossier verdict | Net change |
|---|---|---|---|
| A'.0 framing | ✓ correct | ✓ confirmed | no change |
| A'.1 facet-only resolver | ✓ correct | ✓ confirmed + add stable-ID invariant | minor refinement |
| A'.2 slice streaming | ✓ correct (ReadableStream over RPC) | ✓ confirmed; env capability also viable | minor 🆕 alternative |
| A'.3 barrel synth in facet | ✓ correct | ✓ confirmed | no change |
| A'.4 default cirrus-real | ✓ correct + 🆕 DO Facet upgrade later | unchanged for now | follow-up D' |
| A'.5 esbuild bytes in R2 | ✓ correct | ✓ confirmed | no change |
| A'.NEW.6 yield boundary | ✓ correct | ✓ confirmed | no change |
| A'.NEW.7 per-spec fan-out | ✓ valid; ~5-6 concurrent | ❗ 50 loader-cap + 32 fan-out cap | refined caps + cost guard |

Track A' is **structurally correct**, with three refinements:
1. A'.1 explicitly demands stable LOADER IDs.
2. A'.NEW.7 caps fan-out at 32-per-request (not 5-6).
3. Note that cirrus-real → DO Facet is a Track D' migration target.

---

## §10.2 Track B' — re-evaluation against dossiers

### B'.0 framing — eviction-resilient state via SQL-backed source-of-truth

✓ **CONFIRMED-by-dossier**:

`cf-internal-dossier.md:§9.6 (RPC stub lifetime)`:

> A `Fetcher`/RPC stub from `worker.getEntrypoint(name)` is an
> **I/O object** ... "DynamicWorker is an I/O object, meaning it is
> limited to be used only within a single request context."
>
> Between requests, the coordinator must re-acquire its loader stub
> from `env.LOADER.get(loaderId, callback)` on every invocation.
>
> **For long-lived flows (WebSockets, alarms), state must be in DO
> storage, not held by the coordinator's stubs.**

This is the formal statement that Track B'.0 is mandatory: cross-
request coordinator state HAS to be in DO storage.

### B'.NEW.0 — adopt or reimplement the Agents `runFiber` primitive

🆕 **NEW-OPTION-REVEALED** but with caveat:

The dossiers do NOT mention the `runFiber` / `stash` /
`onFiberRecovered` Agents primitive directly — that lives in the
Agents framework, not the runtime. R6's reference is from the public
Agents docs, which the dossiers don't dispute.

`cf-primitives-dossier.md:§6 invariant I3`:

> **Stub forwarding lifetime ≤ introducer's request**: Coordinator
> can't be a transient Worker if jobs outlive its request. **Default
> to coordinator-as-DO** (or keep a request open via WebSocket /
> Workflow).

Nimbus IS coordinator-as-DO (`NimbusSession`). Plan §3 Track B' design
must build the fiber primitive ON TOP OF the DO actor (with SQL
state), not as a separate runtime feature.

✓ **CONFIRMED**: building the fiber primitive in Nimbus directly
(option B in gate G6) rather than adopting `agents` npm dependency
is consistent with the dossiers' default coordinator pattern. Adopt
the design pattern; not necessarily the package.

### B'.1 — cwd in SQL

✓ **CONFIRMED-by-dossier** — straightforward DO storage usage. No
new constraints.

### B'.2 — terminal scrollback persisted

✓ **CONFIRMED-by-dossier**:

`cloudflare-dynamic-primitives.md:§2.7` (DO limits):

> WebSocket message size: 32 MiB
>
> Storage per Durable Object (sum across all facets): 10 GB

Per-row 2 MB cap (R1.9) confirmed. Scrollback chunks must stay
under 2 MB; chunked design as planned.

### B'.3 — kernel rebuild as pure function of inputs

✓ **CONFIRMED-by-dossier** as sound (no contradiction).

### B'.4 — fold one-shot UI flags into Phase O gate

✓ **CONFIRMED** — Phase O gate is the implementation; fibers cover
"work that crosses eviction"; one-shot UI flags don't.

### B'.5 — replace `/ws` 409 with join-session

🆕 **NEW-OPTION-REVEALED**:

`cf-primitives-dossier.md:§6 invariant I3` (above) means Nimbus's
existing pattern of "the DO holds state across requests" is exactly
what coordinator-as-DO is designed for. Replacing the 409 with
join-session aligns with the platform's intent.

`cf-internal-dossier.md:§4 (Facets)` adds: facet stubs are also I/O
objects bound to a single request. So if Track D' (DO Facets) lands
later, the join-session path needs to work for facets too — the new
WS upgrade reattaches to the LIVE facet stubs.

### B' summary (re-evaluation)

| Item | Original verdict | Dossier verdict | Net change |
|---|---|---|---|
| B'.0 SQL-backed state | ✓ correct | ✓ confirmed (mandated by I3 stub-lifetime) | upgraded to "platform-required" |
| B'.NEW.0 fiber primitive | ✓ correct (R6) | ✓ confirmed; build in Nimbus (don't take `agents` dep) | gate G6 leans toward (B) reimplement |
| B'.1 cwd persist | ✓ correct | ✓ confirmed | no change |
| B'.2 scrollback persist | ✓ correct | ✓ confirmed (2 MB row cap) | no change |
| B'.3 kernel pure | ✓ correct | ✓ confirmed | no change |
| B'.4 Phase O gate | ✓ correct | ✓ confirmed | no change |
| B'.5 join-session | ✓ correct | ✓ confirmed (coord-as-DO) | no change |

Track B' is **structurally correct**, with one minor refinement:
- Build the fiber primitive in Nimbus directly (gate G6 → option B).

---

## §10.3 Track C' — re-evaluation against dossiers

### C'.1 — heap estimator from code constants

✓ **CONFIRMED-by-dossier** — necessary and sufficient.

`cf-internal-dossier.md:§9.2`:

> **Loaded-worker eviction reasons**: Five labelled metrics: `lru`
> (memory pressure), `condemned` (kill), `inactive` (idle),
> `dynamic_worker` (per-owner cap), and `dynamic_worker_banned`
> (Dice).

So workerd actually distinguishes 5 eviction reasons internally.
Bug B fix should ideally surface ALL FIVE in Nimbus's diag, not
just a single "memory pressure" label. Add to C'.1 spec.

### C'.2 — `recovery_event` schema in OOM ring

✓ **CONFIRMED-by-dossier** — directly aligns with the 5-reason
taxonomy above. Use the same labels.

### C'.NEW.3 — interactive-liveness probes

✓ **CONFIRMED** in scope (R6.4 — eviction is 1-2×/day baseline).
The probes need to ASSERT recovery transitions on every eviction
event — frequency comes from the platform.

### C' summary

Track C' is unchanged in shape but **strengthened in detail**:

- C'.1 must support all 5 labelled eviction reasons (lru,
  condemned, inactive, dynamic_worker, dynamic_worker_banned).
- C'.2 recovery_event taxonomy aligns with workerd's existing
  metrics.h labels.

---

## §10.4 Are facets vs Worker Loaders boundaries in Nimbus correct?

**The user's specific question**: does our existing facet-pool
design conflate Loaders-territory work into Facets-territory?

### What Nimbus actually does today

Nimbus's `NimbusFacetPool` (`src/parallel/facet-pool.ts`) is:
- A pool of stubs returned by `env.LOADER.get(stableId, callback)`.
- The stubs are WorkerEntrypoint subclasses (NOT DurableObject).
- No persistent storage on the facet side — each invocation is
  stateless.
- `pLimit(concurrency)` inside one Loader stub for parallelism.

This is **Worker Loader territory**, NOT DO Facet territory. Our
"facet" naming is unfortunate (predates the public DO Facets
primitive) but the implementation is correct for what we use it for.

### What the dossiers say should be where

`cf-primitives-dossier.md:§7` fitness scorecard:

| Workload property | Use Worker Loader | Use DO Facet |
|---|---|---|
| Stateless ephemeral fan-out | ✓ best fit | ✗ overkill |
| Per-job persistent SQLite needed | ✗ paired with facets | ✓ best fit |
| Cross-request coordinator state | ✗ stubs die | ✓ supervisor pattern |
| 65,536 sub-actors per parent | ✗ N/A | ✓ |
| Per-isolate 128 MB independent | ✓ | ✓ |
| Same-host placement guaranteed | ✓ same process | ✓ same parent |

For Nimbus's existing workloads:

- **npm-resolve** (stateless, ephemeral) → Worker Loader — ✓
  CORRECT
- **npm-install batch facet** (stateless, ephemeral, ~30 s of
  work) → Worker Loader — ✓ CORRECT
- **pre-bundle facet** (stateless per spec) → Worker Loader — ✓
  CORRECT
- **cirrus-real** (long-lived vite dev server, has dep cache + HMR
  state) → CURRENTLY Worker Loader, **SHOULD BE DO Facet** —
  ❗ CONFLATED

cirrus-real holds vite's dep cache and HMR client state for the
duration of the session. It's stateful. The current implementation
either (a) loses state on facet eviction, or (b) keeps the facet
warm by holding the loader stub on the supervisor side, which means
state lives in the facet's V8 globals (lost on eviction anyway).

A DO Facet would give cirrus-real:
- Own SQLite for vite's dep cache (currently must round-trip to
  supervisor SQL).
- Own input gate (parallel transforms).
- Survives parent DO eviction with state intact (dep cache rebuilds
  on cold, but HMR connection state can be persisted).

### Verdict on facets-vs-Loaders

✓ **Mostly correct**: 4 of 5 Nimbus subsystems are in the right
primitive (Worker Loader for stateless fan-out).

❗ **Conflated**: cirrus-real is in Worker Loader but should be
in DO Facet (the public primitive). This is a Track D' migration,
NOT Track A'.

The terminology collision (our pool calls itself "facet") should be
resolved by RENAMING `NimbusFacetPool` → `NimbusLoaderPool` in code,
to match the platform-correct term. This is non-blocking; can ship
in any future cleanup.

---

## §10.5 IDEAL primitive mix for npm install + pre-bundle + preview

Based on `cf-primitives-dossier.md:§7` fitness scorecard:

| Workload | Primitive | Reasoning |
|---|---|---|
| Coordinator (NimbusSession) | DO (current) | Coord-as-DO is mandated by I3 (stub lifetime). Single point of session ownership. |
| npm resolve | Worker Loader (named, stable ID `npm-resolve:v1`) | Stateless, ephemeral, low-MB. Score 5/5 parallelism. |
| npm install batch | Worker Loader (named, stable ID `npm-install-batch:v1`) | Same as resolve. Single batch fan-out via internal pLimit avoids 32-fan-out cap. |
| Pre-bundle | Worker Loader, **per-spec stable ID** `prebundle:<spec>:<sliceHash>` | Each spec gets own isolate w/ own 128 MB. Stay within 50 loader-cap + 32 fan-out cap. Per-day uniqueness billing OK because spec-version pairs are bounded across users. |
| Vite dev (cirrus-real) | **DO Facet** (FUTURE — Track D'.1) | Long-lived stateful work with own SQLite for dep cache. Today it's a Worker Loader; should migrate. |
| Preview iframe routing | Same as cirrus-real (the facet handles HMR + asset routing too) | No separate primitive needed. |
| Shell + Kernel | In-supervisor (no facet) | Tiny memory footprint. The "control plane" of the supervisor. |

This is a **slightly refined version** of plan §3 Track A' — adds
the per-spec-ID stable-ID guidance and the Track D' future for
cirrus-real → DO Facet.

---

## §10.6 Container DOs — re-evaluation

`cf-primitives-dossier.md:§3` and `cf-internal-dossier.md:§6`:

> Container DO may be in a different colo from the DO — placement
> picks "nearest pre-fetched container" (RM-24991 in flight to
> flip this).

❗ ARCHITECTURE-IMPACTING — Container DOs do NOT necessarily
co-locate with the parent DO. Plan §3 §6.6 (container migration
declined) was already correct, but the additional reason to
decline (cross-colo latency from supervisor to container per
request) is now documented.

If Nimbus DID migrate to Containers, every shell command would
incur cross-colo RTT to reach the container. UNACCEPTABLE for an
interactive dev environment.

Plan §3 §6.6 (container decline) is reinforced.

---

## §10.7 Track D' (DO Facets migration) — refined

Originally proposed in plan §6.5 as "long-term, post-A'/B'/C'".
Dossier evidence supports keeping this as Track D' but with
specific scope:

### D'.1 — migrate cirrus-real to DO Facet

- Spawn cirrus-real as `ctx.facets.get('cirrus-real-vite', ...)`
  with the dynamic class loaded via
  `worker.getDurableObjectClass('CirrusRealFacet')`.
- vite's dep cache moves to facet's own SQLite (10 GB headroom).
- HMR state can be checkpointed in facet SQL → survives parent DO
  eviction.
- Caveat: facets share parent placement (cf-primitives I4) — no
  cross-machine scaling. Acceptable for per-session vite.
- Caveat: facet alarms are broken in non-root facets (F-8) — must
  drive any timing from supervisor's alarm and pass into facet.

### D'.2 — pre-bundle pool stays Worker Loader

Don't migrate. Pre-bundle is stateless and ephemeral; Worker Loader
is the right primitive (cf-primitives §7 fitness scorecard).

### D'.3 — npm install stays Worker Loader

Same reasoning. Stateless workload; Worker Loader is ideal.

So Track D' has only ONE migration target: cirrus-real. The other
"Nimbus facets" stay as Worker Loaders (correctly).

Track D' is therefore a smaller scope than originally drafted.
~1 multi-wave effort, not 5.

---

## §10.8 Platform-gating discovered (SHIPs we depend on)

Status of platform features Nimbus relies on (from
`cf-internal-dossier.md:§9.5`):

| Primitive | Status | Tickets |
|---|---|---|
| DO Facets | **No production gate observed** beyond DO entitlements. Available where DOs are. | — |
| Worker Loader | **Open Beta with high-risk security review.** GA in flight. | RM-24867 (Closed), RM-27238 (In Progress), REVIEW-14667 (In Progress, risk-high-risk), REVIEW-17120 (Needs Triage), SHIP-13903, SHIP-13904, EW-9655/9656 |
| Container DOs | **Open Beta / private beta**. Allow-listed. | RM-24991 (in flight) |
| Named entrypoints / RPC | **GA**. | — |
| Dispatch Namespaces | **GA**. | — |

❗ ARCHITECTURE-IMPACTING — **Worker Loader is Open Beta**, NOT GA.
Nimbus is BUILT ON Worker Loader. This is a real platform gate.

Consequences:
- Plan §3 should not assume Worker Loader semantics are immutable
  through GA.
- The 50 isolate-per-owner-per-process cap (`dynamicWorkersPerOwnerLimit
  @215`) MAY change in production override; cf-internal-dossier
  open question 1 flags this as unverified.
- Pricing for Dynamic Workers may change at GA; per-day uniqueness
  billing model is "literal comment 'This is not really right
  but…'" per `cf-primitives-dossier.md:§1`.

Implication: plan §3 build dispatches should NOT lock numbers
(specific concurrency caps, specific pricing assumptions) until
Worker Loader is GA. Use the existing `lifo-edge-os` codebase's
already-conservative concurrency = 1 / 3 / pLimit-style pattern
which gracefully degrades if the platform tightens limits.

---

## §10.9 Top-3 architecture-impacting findings (DOSSIER-BACKED)

These are the three findings most consequential for plan §3:

### Top-1 — Nimbus's "facet" naming is misleading; current primitives are MOSTLY correct

**Source**: `cf-primitives-dossier.md:§2` (DO Facets — the platform
primitive) vs Nimbus `src/parallel/facet-pool.ts`.

Nimbus's `NimbusFacetPool` is actually a Worker Loader pool
(WorkerEntrypoint stubs from `env.LOADER.get`), not the public
DO Facets primitive (`this.ctx.facets.get` returning sub-actor
stubs with own SQLite).

For 4 of 5 subsystems (resolver, install, pre-bundle, npm-tarball)
this is **CORRECT** — those workloads are stateless ephemeral fan-out
which IS Worker Loader territory per `cf-primitives-dossier.md:§7`.

For 1 of 5 subsystems (cirrus-real, the long-lived vite dev) this
is **CONFLATED** — cirrus-real has persistent state (vite dep
cache, HMR client state) and would benefit from DO Facets'
own-SQLite + independent hibernation. Track D'.1 migration.

**Plan §3 update**: rename `NimbusFacetPool` → `NimbusLoaderPool`
in code (terminology cleanup). Add D'.1 wave.

### Top-2 — DO eviction is a platform fact (1-2×/day) AND stub forwarding lifetime ≤ introducer's request

**Source**: combination of R6.4 (Agents docs) + `cf-primitives-dossier.md:
§6 invariant I3` + `cf-internal-dossier.md:§9.6`.

Two complementary platform facts:
1. DOs evict at least 1-2× per day from routine runtime restarts.
2. RPC stubs are I/O objects bound to a single request context.

Together they imply: **any state that must survive across requests
HAS to be in DO storage**. This is the design intent of the
coordinator-as-DO pattern. Plan §3 Track B' was originally framed
as elective ("blast-radius mitigation"); R10 confirms it as
platform-required.

**Plan §3 update**: Track B' framing already upgraded (§6.3); R10
just confirms the upgrade was correct.

### Top-3 — Worker Loader is Open Beta with active high-risk PSR

**Source**: `cf-internal-dossier.md:§1` exec summary + §9.5 safety
gating.

Worker Loader is **NOT GA**. It's the substrate for the entire
NimbusFacetPool and therefore for npm install, pre-bundle, and
cirrus-real. Tickets RM-27238, REVIEW-14667, REVIEW-17120,
EW-9655/9656 track GA progress.

Implications for plan §3:
- The 50 isolate-per-owner-per-process cap is the OSS default;
  production may tighten it.
- Per-day uniqueness billing model is acknowledged-imperfect (the
  `dynamic-worker.c++:1050` literal comment says "This is not
  really right but…").
- Dice abuse-detection integration (EW-9653/9655/9656) means our
  workers can be banned at any time.

Build dispatches should NOT lock numbers that depend on Worker
Loader specifics until GA lands. Plan §3 §6.7 (recommended first
build dispatch — Bug B fix heap estimator) is unaffected because
the heap estimator uses Nimbus-internal constants, not Worker
Loader API quirks.

---

## §10.10 Recommended NEW first build dispatch — UNCHANGED

The recommended first build dispatch (plan §6.7) remains **Bug B
fix — heap estimator**. Dossiers don't change this — they confirm
that:

- Without the heap signal, every other architectural claim is
  unverifiable.
- The estimator should align with workerd's 5 eviction-reason
  labels (lru, condemned, inactive, dynamic_worker,
  dynamic_worker_banned per `cf-internal-dossier.md:§9.2`).
- The estimator must be conservative because Worker Loader is
  Open Beta and production caps may differ from OSS defaults.

≤ 60 LOC. Gate 1 (heap estimator approach) must clear first.

---

## §10.11 Net delta to gate matrix

§4.4 had 9 gates after R9 (5 original + 4 new). R10 doesn't add
gates but refines two:

- **G6 (adopt Agents `runFiber` vs reimplement)**: leans toward
  **(B) reimplement in Nimbus**. Reasoning: Nimbus is already
  coordinator-as-DO; the fiber primitive is a small layer over
  DO storage; adding the `agents` package as a runtime dep is
  larger surface than building it.
- **G7 (per-spec-ID dynamic-Worker fan-out)**: refined caps —
  bounded by min(50 loader-cap, 32 fan-out cap). Stable per-(spec,
  sliceHash) IDs to amortise per-day uniqueness billing.

No new gates from R10.

---

## §10.12 Open follow-ups for next research wave

Carrying forward from the dossiers:

| Item | Source | Why it matters for plan §3 |
|---|---|---|
| Production override of `dynamicWorkersPerOwnerLimit` | `cf-internal-dossier.md:§10.1` open Q | Determines actual fan-out ceiling for A'.NEW.7 |
| RPC support for Dispatch Namespaces in production | `cf-primitives-dossier.md:§5` DN-1 | Not relevant for plan §3 (Nimbus doesn't use Dispatch) — defer |
| Facet alarms: broken in production too? | `cf-primitives-dossier.md:§7` F-8 | Relevant for Track D'.1 (cirrus-real → Facet). If broken, drive timing from supervisor. |
| Per-`WorkerCode.modules` total-bytes cap | WL-8 | Relevant for esbuild-wasm bytes path (A'.5). Currently using LOADER `modules` map for ~16 MiB; verify acceptability. |

These are research items, not build gates. Resolve via human
contact (Workers Runtime team Gchat / `workers-runtime@cloudflare.com`)
when the dispatch order reaches the affected wave.
