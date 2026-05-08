# PROD-RESET-INVESTIGATION — Plan

Branch: `prod-reset-investigation`
Scope: **Bug C only** (DO RESET mid-session). Bug A (output ordering) and
Bug B (W5 supervisor-heap log reads zero) are deferred per the reduced
charter. Both already have prior-pass evidence captured under
`audit/probes/prod-reset-investigation/` and will be picked up in
follow-up dispatches.

Prod target: `https://nimbus.ashishkmr472.workers.dev/`, script version
`27dce349-6ab4-4e39-a693-fb04fbbc1663`. Worktree was launched against
`origin/main` at `0a022e6`.

---

## §1 Hypothesis ranking with file:line evidence

The user's symptoms for Bug C (verbatim):

> Session became progressively laggy → DO RESET mid-session — welcome banner
> reprinted, PWD jumped from ~/app back to ~

What MUST be true on a DO reset to produce both visible signals:

1. **`self.shell == null`** — otherwise `/ws` upgrade returns 409 (see
   `src/nimbus-session-routes.ts:92-103`), so the next WS reconnect
   could never re-trigger `initSession()`.
2. **`initSession()` runs again** — that's the only path that emits
   the MOTD via `self.terminal.write(motd + '\r\n')`
   (`src/nimbus-session-init.ts:1873-1874`).
3. **A fresh `Shell` is constructed** — its cwd defaults to whatever
   `~` resolves to, observably `/home/user`. The `Shell` ctor at
   `src/nimbus-session-init.ts:1174` always builds a brand-new shell.

`self.shell = null` is set in exactly four places:

| Site | Trigger |
|---|---|
| `src/nimbus-session-ws.ts:165` | shell-kind WebSocket close |
| `src/nimbus-session-ws.ts:221` | shell-kind WebSocket error |
| (DO ctor — fresh isolate) | cold start / hibernation wake / restart |
| (no in-process self-resets) | n/a |

If the user did NOT close the browser tab and the WS appeared to keep
working before the lag, then a **WS close from the user side** is unlikely.
That points either at a **WS error** (workerd canceling the WS handler at
the 5 s `setHibernatableWebSocketEventTimeout` cap → fires `webSocketError`
→ `self.shell = null`) OR a **DO restart** (cold isolate, `self.shell`
naturally undefined).

Discriminator: `_w9IsolateGen` from `/api/_diag/memory.hib.isolateGen`
(`src/nimbus-session-hib.ts:266-278`). Increments per fresh isolate. In my
70-s and 6-min repros against the same prod deployment, `isolateGen` stayed
flat (1 → 1) — DO did NOT restart in either repro window. That's a STRONG
signal that the steady-state path I exercised is fine, and the user's repro
exercises something I didn't.

---

### H1 — OOM kill (workerd-promoted DO restart)

**Hypothesis**: peak supervisor heap during `npm install` + `npm run dev`
preview-iframe load exceeds the 128 MiB DO cap; workerd resets the isolate
mid-session. On the next WS reconnect attempt, fresh isolate ⇒ no shell ⇒
`initSession()` runs ⇒ MOTD reprints, PWD = `~`.

**File:line evidence**:

- `src/nimbus-session-routes.ts:208` — `DO_HEAP_LIMIT_BYTES = 128 * 1024 * 1024`
  (the documented cap).
- `src/oom-classify.ts:92-93` — recognized OOM error signatures
  (`isolate exceeded its memory limit`, `memory limit ... reset`).
- `src/npm-installer.ts:1539-1544` — slice-walker try/catch comment
  explicitly states: "an unhandled rejection — which workerd can promote
  to a DO restart on a shared isolate". So the codebase already knows
  this failure mode exists.
- `src/parallel/pre-bundle-preamble.ts:42-46` — pre-bundle preamble
  history: "Inline the ~16 MiB base64 in this preamble — workerd allocates
  a 16 MiB module-source string per pool.submit dispatch which combined
  with post-install supervisor heap state OOM-killed the DO on entry to
  the pre-bundle phase (verified on prod)."

**Evidence FOR**: codebase has detailed comments documenting prior OOM
reset of THIS exact code path (npm install + pre-bundle phase). The
welcome-banner reprint + PWD reset are the textbook symptoms of a
fresh isolate.

**Evidence AGAINST**:
- 281 wrangler-tail frames captured during repro: **0 exceptions, 0
  error/warn logs**. An OOM kill produces an `exception` frame in tail
  with the message "Durable Object's isolate exceeded its memory limit
  and was reset" per `src/oom-classify.ts:14-15`. None observed during
  my repro window.
- `lastFailures` from the OOM ring buffer was empty (length 0) in the
  diag-trace samples — but the ring buffer is **rehydrated from storage
  on cold boot**, so a reset that happened just before my poll could
  read empty-ring without disproving anything.
- BUT: `_diagPeakHeapUsed` is locally `0` in every diag sample because
  workerd's `process.memoryUsage()` returns zero inside the DO context
  (this is Bug B, deferred). So we have NO live signal for heap pressure.
  H1 is provisionally consistent with everything observed.

**Verdict**: **PRIMARY HYPOTHESIS** — strongest match for the user's
visible symptoms; consistent with prior code-comment history of OOM
resets in this exact phase; not contradicted by tail data because tail
captured no event during the user's failure window. The harness gap
(no live supervisor-heap signal — Bug B) is what makes this hypothesis
hard to confirm without a second-tier probe.

---

### H2 — SupervisorRPC throws uncaught during install/pre-bundle, DO restarts

**Hypothesis**: a SupervisorRPC method called by a facet (e.g.
`getEsbuildWasm`, the pre-bundle progress reporter, or one of the
W6/W6.5 registry helpers) throws an unhandled rejection on the
supervisor side; workerd promotes this to a DO restart.

**File:line evidence**:

- `src/supervisor-rpc.ts:130` — "W5 Lever 5: record the frame on entry
  so /api/_diag/memory has..." — every RPC entry is recorded into the
  ring; if a recent throw happened, the ring would show it.
- `src/npm-installer.ts:1465` — comment explicitly warns about
  unhandled-rejection-becomes-DO-restart for npm-installer code paths.

**Evidence FOR**: the frame-recording infrastructure exists precisely
because this failure mode has been observed before.

**Evidence AGAINST**:
- 281 tail frames, zero `exceptions[]` populated, including across all
  135 SupervisorRPC frames captured.
- `outcome=canceled` happened 36×, all on SupervisorRPC isolates, but
  with wallTime up to only 2.66 s — these are facet teardowns, not
  uncaught throws (an exception would surface as `outcome=exception`
  on a different frame).

**Verdict**: **WEAK** — not contradicted, but no positive evidence in
the captured tail. Demote unless we get a tail capture covering an
actual user-side reset.

---

### H3 — W9 hibernation kicks in mid-active-WS, state lost on wake

**Hypothesis**: the DO hibernates while the user thinks the session is
alive; on the next user keystroke, workerd wakes a fresh isolate; the
WS reconnects through `setWebSocketAutoResponse` ping/pong; but
re-init runs `initSession()` because the constructor's per-isolate
state is gone.

**File:line evidence**:

- `src/ws-hibernation-config.ts:38` — `NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS = 5000`
  the platform 5 s cap on hibernatable WS-event handlers.
- `src/ws-hibernation-config.ts:77-80` — `setWebSocketAutoResponse` for
  ping/pong so idle sockets DON'T wake the DO. Documented as preventing
  the wake-thrash described in the hypothesis.
- `src/nimbus-session-hib.ts:266-278` — `maybeBumpIsolateGen` runs once
  per fresh isolate; my diag-trace shows `isolateGen` stable at 1 across
  the full repro window — i.e. NO hibernation wake during the repro.

**Evidence AGAINST**:
- `isolateGen` was 1 throughout my long repro. If hibernation/wake had
  happened, it would have bumped to 2.
- The auto-response is configured (verified by curl: `hib.autoResponse
  Configured: true`). So idle WS pings don't wake the DO.

**Verdict**: **WEAK** — the architecture explicitly defends against
this; the live observation rules it out for my repro. Could still bite
on a long-idle path (>15 min) but the user's failure was "mid-session"
not "after long idle".

---

### H4 — Watchdog / auto-eviction (alarm, subRequest cap)

**Hypothesis**: a runaway alarm or a subRequest-cap-exceeded error
triggers a DO restart.

**File:line evidence**:

- `src/nimbus-session-hib.ts:244-251` — `setAlarm` is called with
  `Date.now() + W9_FLUSH_DEBOUNCE_MS * 4` after every shell-kind WS
  close (via `scheduleHibFlush`). Best-effort, error-swallowed.
- `src/nimbus-session-hib.ts:258-264` — alarm dispatcher only does
  `processLogs.flush()`. Cheap.
- `src/oom-classify.ts:88-89` — `'too many subrequests'` recognized as
  `subrequest_cap` cause.

**Evidence AGAINST**: alarm dispatcher is a no-op shell flush. SubRequest
cap is 1000 per request — a reasonable npm install + 8-module pre-bundle
shouldn't approach this. None of the 281 tail frames show a subRequest-cap
error.

**Verdict**: **WEAK** — provisionally rule out. Re-examine only if
post-fix telemetry shows an alarm-triggered cause cluster.

---

### H5 — Worker Loader concurrency limit cycles supervisor

**Hypothesis**: too many concurrent dynamic worker isolates force
workerd to evict the supervisor itself.

**File:line evidence**:
- `src/parallel/facet-pool.ts:519` — slice-memory comment: "~56 MiB of
  slice memory in the supervisor heap for a full" run; combined with
  multiple-pool concurrency this can pressure the supervisor.
- `src/npm-installer.ts:1485` — pre-bundle pool with concurrency=1
  (`PRE_BUNDLE_CONCURRENCY` from the same file).
- `wrangler.jsonc` — uses LOADER binding for dynamic workers.

**Evidence AGAINST**:
- Pre-bundle is `concurrency=1`. Install is one batch-facet at a time.
  The only multi-facet load is rare (e.g. pre-bundle + npm-resolve in
  flight simultaneously, which the code already serializes).
- 36 SupervisorRPC `canceled` outcomes are all consistent with NORMAL
  facet teardown after work completes (workerd cancels stateless
  isolates whose work finished).

**Verdict**: **WEAK** — would need direct evidence of concurrent-pool
race that doesn't exist in the current code.

---

### H6 — Other (process / shell-side null without DO restart)

**Hypothesis**: `self.shell` gets nulled by the WS error handler
(`src/nimbus-session-ws.ts:221`) on a transient socket error — not a DO
restart at all. The terminal client auto-reconnects, hits `/ws`, and
because `self.shell == null`, `initSession()` runs again on the SAME
isolate. The user sees MOTD + cwd=`~` but the rest of DO state
(viteDevServer, facetManager, sqliteFs cache, etc.) still works.

**File:line evidence**:

- `src/nimbus-session-ws.ts:173-224` — `wsError` discriminator nulls
  `self.shell`/`terminal`/`kernel` on shell-kind errors but PRESERVES
  the rest of session state.
- `src/nimbus-session-routes.ts:92-103` — `/ws` rejects when `self.shell`
  is non-null but ACCEPTS when it's null.
- `src/nimbus-session-init.ts:1873-1874` — MOTD print on every
  `initSession` invocation.

**Critically**: a hibernatable webSocketMessage handler exceeding the
5-s `setHibernatableWebSocketEventTimeout` IS a documented WS error
mode (workerd cancels the handler and fires `webSocketError`). The
captured tail shows 22 frames clustered at ~5 085 ms — within 200 ms of
the 5 000 ms timeout. **This is the strongest direct positive evidence
in the entire capture.** It's NOT proof that the timeout fired on a WS
event (these are HTTP fetch frames whose long wallTime could be DO-input-
lock waits caused by WS handlers timing out), but it IS the smoking gun
for "something is regularly hitting the 5 s gate".

**Evidence FOR**:
- 22 tail frames at ~5 085 ms — quantitative match to the 5 000 ms cap.
- 12 frames at 15-60 s, 4 frames at >60 s (max 106 747 ms ≈ 21 × 5 000 ms).
  Suggests cascading 5-s timeouts: a handler that re-queues after the
  cancel and times out again, again, again.
- This hypothesis CAN explain "PWD reset to ~" (fresh shell) and "MOTD
  reprint" (re-init) WITHOUT requiring isolateGen to bump — so it's
  fully consistent with my diag-trace showing isolateGen stable at 1.

**Evidence AGAINST**:
- `webSocketError` only fires for hibernatable WS errors. The shell WS
  is hibernatable (accepted via `ctx.acceptWebSocket(server)` at
  `src/nimbus-session-routes.ts:106`), so this is plausible — but I'd
  expect it to show up as an EXCEPTION in the wrangler tail. None did
  during my repro.
- BUT: `webSocketError` is wrapped in try/catch in
  `src/nimbus-session-ws.ts:103` for the message handler. The
  `recordFailure` call at `src/nimbus-session-ws.ts:204-214` would
  record a `phase: 'ws'` failure. My diag-trace shows `lastFailures: 0`
  — so either the user's failure happened before my window, or the
  ring buffer has been cleared.

**Verdict**: **PRIMARY HYPOTHESIS (tied with H1)** — the 5 085 ms cluster
is the only quantitative anomaly in the captured tail. H6 + H1 are not
mutually exclusive: a 5-s timeout under heap pressure could be both an
OOM precursor (work that allocates fast can hit memory limit before time
limit) and the trigger for the user-visible reset.

---

## §1.X Summary

| H | Verdict | Confidence | Smoking-gun evidence |
|---|---|---|---|
| H1 OOM kill | **PRIMARY** | medium-high | code-comment history; not contradicted; no live heap signal due to Bug B |
| H2 SupervisorRPC throw | weak | low | zero exceptions in 281 tail frames |
| H3 hibernation wake | weak | low | isolateGen stable at 1 through full repro |
| H4 alarm/subRequest | weak | low | no signature match in tail |
| H5 Loader concurrency | weak | low | code already serializes; no race surface visible |
| **H6 5-s WS-event timeout** | **PRIMARY** | medium-high | **22 tail frames at ~5 085 ms; max 106 747 ms ≈ 21 × 5 s — quantitative match to cap** |

**Top combined hypothesis**: H1 + H6 together explain all observations:
heap pressure during pre-bundle + preview iframe load → some hibernatable
WS handler exceeds 5-s cap → workerd cancels handler + fires
`webSocketError` → `self.shell = null` → user keypress reconnects WS →
fresh `initSession()` → MOTD reprints, PWD = `~`. The user perceives this
as a "DO reset" because it looks identical to a cold-isolate boot.

§2 (verdict) and §3 (fix) follow in subsequent commits.

---

## §2 Root-cause verdict

### §2.1 The reset's USER-VISIBLE mechanism is independent of which trigger fires

Per the file:line evidence aggregated in §1, **whichever trigger fires
(H1 OOM, H6 5-s timeout, or any other route to `webSocketError`)**, the
end-to-end user-visible flow is identical and fully explains the
reported symptoms:

```
trigger (OOM | 5-s timeout | uncaught throw | …)
  → workerd fires webSocketError on the shell-kind WebSocket
  → src/nimbus-session-ws.ts:173-224 wsError() runs, nulling
    self.shell / self.terminal / self.kernel
  → server-side connection drops; client-side public/s/index.html:432
    triggers ws.onerror → ws.close()
  → public/s/index.html:427-430 ws.onclose() backs off and reconnects
    after rd ms (starts at 1000 ms, 1.5× until 10 s cap)
  → next /ws upgrade arrives at src/nimbus-session-routes.ts:81
  → because self.shell is now null, the 409-rejection branch
    (lines 92-103) does NOT fire, and the upgrade succeeds
  → src/nimbus-session-routes.ts:115 calls self.initSession(server)
  → src/nimbus-session-init.ts:67 constructs a fresh Kernel
  → src/nimbus-session-init.ts:1174 constructs a fresh Shell
    (cwd defaults to /home/user — observable as "PWD jumped to ~")
  → src/nimbus-session-init.ts:1873-1874 reads etc/motd from VFS and
    writes it to the new terminal — observable as "welcome banner
    reprinted"
```

This means **the verdict is the trigger, not the reset path** — the reset
path is the same regardless. The fix surface bifurcates accordingly:

1. **Eliminate the trigger** (H1 fix: heap-pressure reduction; H6 fix:
   ensure no hibernatable WS handler runs >5 s).
2. **OR mitigate the user-visible blast radius** (treat a transient
   server-side reset as recoverable: persist cwd, suppress MOTD on
   silent re-init, etc.).

A full fix needs the trigger. A blast-radius mitigation alone leaves
the underlying instability in place but immediately neutralizes the
P0 symptom.

### §2.2 Trigger verdict: H1 OOM is the most likely trigger; H6 is the precise mechanism

**Lock**: H1 (OOM) is the most likely TRIGGER, and the firing path runs
through H6 (5-s WS-event timeout because the OOM kills mid-handler) to
produce the observed `webSocketError` → `self.shell = null` chain.

Justification for the H1 trigger lock:

- The user reported "session became progressively laggy" — classic
  signature of GC pressure + heap thrash near the 128 MiB cap.
- The user's repro is exactly the combination flagged in
  `src/parallel/pre-bundle-preamble.ts:42-46` as having OOM-killed the
  DO before: post-install heap state + pre-bundle phase with 8 modules.
- Bug B (W5 telemetry zero) means we have NO live heap signal — the
  /api/_diag/memory `peak.heapUsedBytes` is structurally 0 in prod
  (per the comment at `src/nimbus-session-routes.ts:210-218`:
  "workerd's process.memoryUsage() returns 0 for all fields inside DO
  class contexts"). So the "no OOM signal in tail" evidence is
  ARTIFACTUALLY weak, not actually weak.
- The 5-s wallTime cluster (22 frames at ~5 085 ms) is consistent with
  workerd canceling a hibernatable WS handler that exceeded the cap —
  which is exactly what happens to the WS handler running near OOM
  pressure (its allocation sites get progressively slower as GC churns,
  eventually exceeding the budget).

**Confidence**: medium-high for the trigger family (H1+H6); medium for
the exact mechanism within that family (H1 alone vs H1-via-H6).

Justification for stopping here without sub-mechanism precision:

1. The investigation did not reproduce Bug C in 7 minutes of prod
   probing across two repros (one 70 s, one 6 min). Asking for more
   reproduction time without the harness gap closed (Bug B) buys
   diminishing returns — the next probe will see the same zero-heap
   signal we already have.
2. The §3 fix sketch can address H1 and H6 in ONE change (a
   bounded-heap supervisor watcher + a 5-s ceiling on the shell WS
   message handler) since both reduce to the same surface: no
   webSocketError, no shell null, no reset.

§3 (fix sketch + rollout-risk) follows in the next commit.

---
## §3 Architectural redesign — three tracks

The previous §3 prescribed two patch fixes (cwd-persist + MOTD-suppress)
that hide symptoms without addressing trigger or recovery correctness.
**That §3 was reverted** (revert commit `2e4d80b`) after the user
explicitly rejected patch fixes:

> "I dont want any hacky or patchy fixes ever. I want solid architectural
> improvements that guarantee things would work even under memory pressure."

This §3 replaces it with three architectural tracks. Each track targets
a different architectural property of the system; together they should
make the user-visible Bug C symptom disappear AS A CONSEQUENCE of
correctness, not as a separate fix.

### §3.1 What each track owns

| Track | Owns | Goal |
|---|---|---|
| **A'** Memory-pressure containment | the **trigger** — supervisor heap pressure during install + pre-bundle + dev | The supervisor isolate has a bounded, KNOWN heap budget under realistic load. OOM is structurally impossible (memory pressure cannot exceed an explicit ceiling), not avoided by tuning. |
| **B'** Session coherence under failure | the **recovery path correctness** — what happens when state IS lost | Lost in-isolate state recovers by re-deriving from a persistent source of truth. Recovery is a designed lifecycle, not an accidental side-effect of `self.shell = null`. |
| **C'** Observability prerequisites | the **measurement** — what counts as proof an architectural change works | We can SEE supervisor heap, recovery transitions, and OOM events directly. No architectural claim ships without a probe that asserts the claim under load. |

The three tracks are partially independent. Bug B fix is a hard
prerequisite for C' (no signal → no verification). A' and B' can ship
in parallel once C' minimally exists.

---

### §3.2 Track A' — memory-pressure containment (the trigger)

**Goal**: the supervisor isolate has a known, bounded heap budget under
the user's reported load. Pressure cannot make the supervisor unstable
because **work that allocates is structurally external to the supervisor**.

#### §3.2.1 Architectural invariants A' must enforce

1. **Supervisor never holds bulk bytes.** Any single contiguous
   allocation > 1 MiB must live in a facet, in R2, or in SQLite — never
   in supervisor heap. The supervisor's job is routing + control flow,
   not data movement.

2. **Per-phase peak heap is computable from code, not measured.** Every
   phase that allocates (resolver, install, pre-bundle, vite handle-
   request, cirrus-real boot) has a written peak-heap calculation
   sourced from constants in code (slice cap, concurrency, RPC frame
   cap). The number is a comment near the phase entry; CI checks the
   sum stays under a target ceiling (initial proposal: ≤ 64 MiB —
   half the documented 128 MiB cap to leave headroom for the
   "shared isolate" reset behaviour at `src/npm-installer.ts:1402-
   1409`).

3. **No fire-and-forget heap-allocating work.** Every Promise that
   allocates must be awaited or registered with `ctx.waitUntil`. Every
   `setTimeout` that allocates must have an explicit cancel path. (Today
   `src/heavy-alloc-coord.ts` is the contract for "I'm allocating, GC
   please yield"; A' tightens this so non-registered allocations
   are caught.)

#### §3.2.2 Specific gaps in current code

- **A'.1 — Resolver phase still has an in-supervisor fallback path**
  at `src/npm-installer.ts:507-560` (`resolveDepGraphInFacet`).
  The comment at `src/npm-installer.ts:526` notes "a cold session — which
  is correct, just slower for warm-cache paths". The fallback path is
  guarded but exists; it allocates packument bytes in supervisor heap.
  Action: enforce facet-only resolution. Remove the supervisor fallback
  with a feature flag default-on; supervisor resolution becomes a
  test-only path. New invariant probe: assert the `resolverPath` diag
  counter (today set at `src/npm-installer.ts:343`) reads `'facet'` on
  every prod install.

- **A'.2 — Pre-bundle slice walker runs in the supervisor**
  at `src/npm-installer.ts:1545-1559`. The slice is built in supervisor
  memory before being submitted to the facet pool. Even with the
  28 MiB SLICE_CAP_BYTES cap, this puts up to 28 MiB of bytes in
  supervisor heap simultaneously with the in-flight RPC frame to the
  facet (which transports the same bytes again — workerd's structured
  clone for `pool.submit` payload). Action: stream the slice directly
  from VFS to facet via an RPC handle (facet pulls bytes via a
  SUPERVISOR.readSliceChunk(specifier, offset, len) RPC) instead of
  passing the full slice as a structured-clone argument. Cuts
  supervisor peak from ~34 MiB to ~few MiB during the pre-bundle phase.

- **A'.3 — Synthesized barrel for icon libraries (lucide-react etc.)
  goes through the supervisor**: see the `synthesized entry for
  lucide-react` log line at `src/npm-installer.ts:~1567` and
  `buildScopedSliceForSynthetic` (referenced at line 1555). For a
  3 940-file icon library this can hold thousands of small file
  buffers in supervisor heap. Action: synthesize the barrel inside
  the pre-bundle facet itself, after the slice-streaming change above.
  The facet has its own 128 MiB budget; the supervisor doesn't have
  to host the synthesis.

- **A'.4 — Vite dev server lives in the supervisor isolate**
  per `src/nimbus-session-routes.ts:545-571` (the lazy-init block).
  Per-request transforms allocate inside the supervisor heap; on hot
  reload they double-allocate before GC catches up. The cirrus-real
  alternative path at `src/nimbus-session-routes.ts:509-541` already
  runs vite IN A FACET. Action: make cirrus-real the default; deprecate
  the in-supervisor `viteDevServer` path on a roadmap with a flag
  override for fallback. Reduces supervisor peak heap during active
  HMR significantly.

- **A'.5 — esbuild-wasm bytes (~16 MiB) currently transit the
  supervisor** per `src/parallel/pre-bundle-preamble.ts:42-46` history.
  The current "bytes ride INSIDE the LOADER `modules` map" approach
  (line 55) keeps them out of per-dispatch heap, but the supervisor
  STILL holds the bytes at `src/esbuild-wasm-bytes.ts` for the
  duration of the DO lifetime. Action: cache the bytes in R2 and pull
  on-demand from the facet (R2 GET inside the facet, not RPC through
  the supervisor). Removes ~16 MiB of permanent supervisor heap.

#### §3.2.3 What we need to MEASURE before claiming A' works

A' is a memory-pressure-containment claim; we MUST observe peak
supervisor heap during the user's reported load before and after each
change. That requires C' (Bug B fix). Without C', any A' change is
"plausibly improves" not "verified improves".

---

### §3.3 Track B' — session coherence under failure (recovery correctness)

**Goal**: when ANY component fails (OOM, RPC throw, hibernation cycle,
operator-induced reset), the recovery is a designed transition between
states stored in SQLite, not an accidental rebuild from in-isolate
defaults.

#### §3.3.1 Architectural invariants B' must enforce

1. **All session state has a SQL-backed source of truth.** Every field
   that the user can observe (cwd, terminal scrollback, env, kernel
   mount tree, running-process list, vite config) has a designated
   storage key and a serialize/rehydrate pair. The in-isolate field is
   a CACHE of the SQL row, not the master copy.

2. **`initSession` is idempotent and split into "rehydrate" + "boot".**
   Today `initSession` at `src/nimbus-session-init.ts:59-1985` does
   both; the rehydrate-vs-cold-boot decision is implicit in `if-not-set`
   field checks scattered through the body. B' splits this into
   explicit phases:
   - **Phase R**: rehydrate from SQL (cwd, env, mounts, processes,
     vite config). Pure; no terminal output; no MOTD.
   - **Phase B**: boot subsystems that aren't already alive
     (sqliteFs, kernel, shell) using rehydrated state.
   - **Phase W**: wire WebSocket — `terminal = new WebSocketTerminal(ws)`.
   - **Phase O**: any one-shot output (MOTD, framework hint) — gated
     on `_motdShownInThisIsolate` becoming a derived predicate of
     "this is the FIRST initSession call against a freshly-constructed
     DO instance" (i.e. after a true cold isolate boot). The gate is
     no longer a cosmetic suppression; it's a derived consequence of
     phase R having found state vs. not.

3. **`webSocketError` / `webSocketClose` are recovery EVENTS, not
   teardown commands.** Today
   `src/nimbus-session-ws.ts:165` and `:221` null `self.shell`,
   `self.terminal`, `self.kernel` directly. B' replaces this with a
   `host.transitionTo('drained')` call that:
   - persists the current shell cwd/env/scrollback before nulling,
   - cancels any in-flight kernel-side jobs cleanly (today they leak),
   - emits a structured `recovery_event` to the OOM ring (today these
     are invisible — see C').
   The next `/ws` upgrade calls `host.transitionTo('hydrated')` which
   runs Phases R + B + W + O above.

4. **Long-lived facets (vite, cirrus-real) survive the WS lifecycle.**
   The current code already tries to preserve them (the comment at
   `src/nimbus-session-ws.ts:139-142` says "Dev servers (vite, wrangler
   dev) + long-running facets must still survive the terminal
   reconnect"). B' validates this with an explicit cross-WS contract:
   the facet's loader-cache key + storage-backed config are sufficient
   to reattach.

#### §3.3.2 Specific gaps in current code

- **B'.1 — cwd lives only in shell-instance memory**. The Shell class
  at `node_modules/@lifo-sh/core/dist/shell/Shell.d.ts` declares
  `private cwd` and the builtin `cd` writes it directly. Action: in
  `src/nimbus-session-init.ts` post-Shell-construction, install a real
  observer (NOT a monkey-patched property accessor) that reads cwd
  on every prompt cycle and writes it to SQL via a debounced
  `ctx.storage.put`. Rehydrate cwd in Phase R.

- **B'.2 — terminal scrollback is lost** entirely on WS close.
  `WebSocketTerminal` at `src/ws-terminal.ts:5-55` has only
  `this.buffer: string[]` (the in-flight write batch) and no history.
  Action: layer a ring-buffered scrollback store on top, persisted
  to SQL on debounce; rehydrate on Phase R and emit to the new
  terminal as the first write.

- **B'.3 — kernel is rebuilt fresh on every initSession**
  per `src/nimbus-session-init.ts:67-68` (`new Kernel(new
  MemoryPersistenceBackend())`). Today this is required because the
  kernel's mount provider list is built imperatively. Action: derive
  the mount list from a static config (already mostly the case at
  line 71-75) so the kernel becomes purely a function of inputs;
  in Phase R the rehydration restores kernel-level state (env vars,
  alias map, process registry) from SQL.

- **B'.4 — `wranglerAliasBannerShown` is a one-shot in-isolate flag**
  declared at `src/nimbus-session-internal.d.ts:111` and used at
  `src/nimbus-session-init.ts:1004-1008`. This is the SAME class of
  bug as the rejected A.2 MOTD-suppress flag — it tracks one-shot UI
  state in isolate memory, breaks on every silent re-init. B' folds
  ALL one-shot UI flags into the "Phase O" gate (i.e. they fire only
  on a TRUE cold-isolate boot, identifiable by Phase R finding
  zero rows for the session — not by a transient flag).

- **B'.5 — `self.shell != null` 409 check at
  `src/nimbus-session-routes.ts:92-103`** is the wrong gate. It's
  there because `initSession` overwrites the shell, but in B' the
  recovery transition handles this cleanly. Action: replace the 409
  with a "join existing session" path that reuses the live shell and
  re-attaches the new terminal — single browser tab, but the OLD
  terminal's WS gets a kindly close and its scrollback survives.

#### §3.3.3 What B' is NOT

B' is NOT "make the reset invisible" (that was the rejected A.2). B'
makes the reset CORRECT and OBSERVABLE — the user sees a single line
like `[nimbus] session recovered after isolate restart (gen 2 → 3, no
data loss)` AS THE FIRST OUTPUT after a recovery. The MOTD does NOT
print on a recovery — not because we suppress it, but because Phase O
has found prior state in SQL.

---

### §3.4 Track C' — observability that proves architecture works

**Goal**: every claim in A' and B' is backed by a probe that asserts
the claim under load. No claim is "verified" without a green probe.

#### §3.4.1 Bug B fix is a hard prerequisite

`src/npm-installer.ts:1936-1945` (`readSupervisorHeap`) calls
`process.memoryUsage()` which returns zero in DO context per the
comment at `src/nimbus-session-routes.ts:210-218`. So today the only
"supervisor heap pressure" signal we have is **inferred from
application-level counters** (cumulativePackumentBytesDecoded,
inFlightBytes, etc.) — those are correct but indirect.

C'.1 — replace `readSupervisorHeap` with a synthetic estimator that
sums the architectural budgets from the code-cited calculations in
A'.1-A'.5. The estimator is deterministic per-phase (from constants).
Probe: assert estimated heap matches independently-counted bytes
(via the existing `diag-counters.ts`) within ±10 %. If they diverge,
either the code calculation is wrong or there's an unaccounted
allocation site — both are A' bugs.

C'.2 — surface `recovery_event` entries in the OOM ring
(`src/oom-discriminator.ts:54` already tracks `heapUsedBytes`; extend
the schema to add `phase: 'recovery'` and the from→to state for
every B' transition). Probe: assert that under a 10-minute interactive
load (the user's reported flow + preview iframe + multi-tab), the ring
shows ≥ 0 recovery events all with `data_loss=false`.

#### §3.4.2 Build the interactive-liveness probe class FIRST

Per the retro at `audit/sections/PROD-RESET-INVESTIGATION-retro.md §4`:

- §4.1 Long-form replay probe (10+ min WS + parallel /preview/...
  fetches; assert isolateGen, banner count, recovery events, wallTime
  p99).
- §4.2 wallTime distribution snapshot (5-min wrangler tail; assert
  < 5 % frames in the ~5 s bucket).
- §4.3 Trigger drill — synthetic webSocketError; assert recovery
  transitions out cleanly (B'-bound assertion).

These three components must EXIST and be GREEN before any A' or B'
change is declared verified. Until then changes are "plausible" not
"verified".

---

## §4 Dispatch order

### §4.1 Hard ordering

```
        ┌──────────────────────────┐
        │ Bug B fix                │  (telemetry: real or estimated heap)
        │ — own dispatch           │
        └────────────┬─────────────┘
                     │ (prereq)
        ┌────────────▼─────────────┐
        │ C'.1 + C'.2              │  (heap estimator + recovery_event)
        │ — own dispatch           │
        └────────────┬─────────────┘
                     │ (prereq)
        ┌────────────▼─────────────┐
        │ Interactive-liveness     │  (probes from retro §4)
        │ probe class build-out    │
        │ — own dispatch           │
        └────┬──────────────┬──────┘
             │              │
        ┌────▼─────┐   ┌────▼──────┐
        │ Track A' │   │ Track B'  │   (parallelisable; review-gated)
        │ A'.1-5   │   │ B'.1-5    │
        └────┬─────┘   └────┬──────┘
             │              │
             └──────┬───────┘
                    │
        ┌───────────▼──────────────┐
        │ Cross-track verification │
        │ + retro                  │
        └──────────────────────────┘
```

### §4.2 Dispatch granularity

- **Bug B fix**: ONE wave. Smallest dispatchable unit. ≤ 60 LOC.
- **C'.1 (heap estimator)**: ONE wave. ≤ 120 LOC including tests.
- **C'.2 (recovery_event schema)**: ONE wave. ≤ 80 LOC.
- **Interactive-liveness probes**: ONE wave per probe (3 waves total).
  Each is a probe-only addition; no src/ change. ≤ 200 LOC each.
- **Track A'.1-5**: FIVE waves. Each addresses one supervisor-heap
  source. Each ships with the C'.1 estimator delta (before/after) as
  acceptance evidence. Each is independently revertable.
- **Track B'.1-5**: FIVE waves. Each addresses one in-isolate state
  source. Each ships with a recovery probe asserting the rehydrate
  path works under at least one synthetic trigger.
- **Cross-track verification**: ONE wave. Runs the full
  interactive-liveness probe class against a deployed prod-like
  target; asserts zero MOTD reprints, zero data-loss recovery events,
  ≤ 64 MiB estimated peak supervisor heap.

### §4.3 Why this dispatch order vs. shipping A' or B' first

If we ship A' before C': any A' fix lands "plausibly works", we have
no way to prove it; the next prod regression is invisible.

If we ship B' before C': B' transitions are invisible until the
recovery_event schema exists. Probes can't assert correctness.

If we ship A' before B': A' reduces OOM probability but doesn't fix
recovery correctness for the cases A' doesn't cover (RPC throw,
hibernation cycle, operator reset). User would still see the same
visible Bug C symptoms whenever the trigger is non-OOM.

If we ship B' before A': B' makes recovery correct, but the trigger
keeps firing under heap pressure, so users see frequent (now-correct
but still annoying) recoveries. Trade-off acceptable IF C' is in
place to count them and the rate is low enough.

### §4.4 Review-gated boundaries (USER REVIEW POINTS)

UPDATED 2026-05-08 after research wave R1-R6 (synthesis at
`audit/sections/PROD-RESET-RESEARCH-SYNTHESIS.md`). The previous
5-gate matrix is replaced with the 8-gate matrix below. See
`audit/sections/PROD-RESET-RESEARCH-SYNTHESIS.md` §S.4 for the
gate-by-gate transition rationale.

The user has explicitly rejected hidden patch fixes. The following
are gates where I MUST stop and get explicit approval before
proceeding:

1. **G1 Before Bug B dispatch — heap-estimator approach**: confirm
   the deterministic-from-code-constants approach is the right
   fork (vs. trying again to get a real `process.memoryUsage`).
   Research note (R1.4): SQLite page cache vs JS heap accounting
   is unverified; estimator should validate against
   `diag-counters.ts` aggregates within ±10 % so the gap is
   visible.

2. **G2 Before any A' dispatch — Track A' invariant**: confirm the
   broader invariant "supervisor never holds bulk allocations
   >1 MiB". This generalizes the previous "remove resolver fallback"
   gate. The resolver fallback path (`src/npm-installer.ts:507-560`)
   is one of multiple supervisor-bulk-allocation sources; the
   invariant captures all of them. User confirms the invariant; A'.1
   through A'.NEW.7 are the consequences.

3. **G3 Before A'.4 dispatch — deprecate in-supervisor vite**:
   confirm "deprecate in-supervisor `viteDevServer`, default
   cirrus-real" is the chosen direction. Largest behavioural
   change in A' — affects HMR routing, asset paths, preview iframe
   integration.

4. **G4 Before B'.5 dispatch — `/ws` 409 → join-session**: confirm
   replacing the `/ws` 409 reject with a "join existing session"
   path is acceptable. UX change: what does an old browser tab see
   when a new tab joins? After fiber-style B' (G6) lands the live
   shell IS reusable across WS upgrades — the 409 was a defensive
   workaround for the recovery gap.

5. **G5 ~~64 MiB peak-heap ceiling~~** — DROPPED. Rationale (R6.4):
   even a perfect 64 MiB ceiling won't prevent the 1-2×/day
   eviction baseline. The right metric is invariant-shaped (G2),
   not numeric. Confirming the drop is the gate.

6. **G6 Before B'.NEW.0 dispatch — adopt Agents `runFiber` vs.
   reimplement**: the Agents framework's fiber primitive
   (`runFiber`/`stash`/`onFiberRecovered`) is the platform-blessed
   pattern for eviction-resilient long-running tasks (R6.4).
   Choices:
   - (A) Adopt the `agents` npm package as a runtime dependency.
     Adds dependency surface but inherits future improvements.
   - (B) Reimplement the primitive inline in Nimbus, citing Agents
     as design source. No external dep.
   Both ship the SAME runtime semantics. User chooses dependency
   stance.

7. **G7 Before A'.NEW.7 dispatch — per-spec-ID dynamic-Worker
   fan-out**: per-spec parallelism for pre-bundle would split N
   specs across N stubs (each LOADER ID = `prebundle:<spec>:<sliceHash>`)
   so the platform can place each in a distinct isolate (R2.5).
   Stay within 32 service-binding-invocations cap (F.5).
   Tradeoff: more orchestration overhead vs better isolation.
   User confirms direction.

8. **G8 Before any architectural commit — confirm Containers
   declined**: Cloudflare Containers (R5) trivially solve Bug C's
   memory-pressure trigger but constitute a product pivot from the
   workerd-isolate model. Plan §3 / §6.6 explicitly declines this
   path. The user's strategic identity question — "is Nimbus a
   workerd-isolate dev env or a real-Linux container dev env?" —
   needs an explicit answer before any architectural code lands.
   Default position: stay with workerd isolates.

9. **G9 Before A' / B' commit — Workflows alternative**: an
   alternative architecture for npm install / pre-bundle is
   modelling them as Cloudflare Workflows with `step.do()` per
   phase (R6.3). Each step is durable-by-construction. Tradeoffs:
   Workflows are a separate primitive with own billing; require a
   compat-date-bumped flag; restructure the phase orchestration.
   Default position: stay with current orchestration; revisit if
   B' fiber primitive doesn't deliver. User confirms default.

**Gate ordering**: G1 ≺ G8 ≺ G2, G6 (parallel) ≺ G3, G4, G7, G9
(parallel) ≺ A' / B' implementation waves. G5 is a one-time drop
confirmation.

---

## §5 What is explicitly NOT in this plan

- **No symptom-hiding patches** of the rejected Track A class.
- **No "compatibility flag for old behaviour"** for A' or B' changes
  beyond the immediate rollout window. The point is to make the
  architecture correct; flags that preserve the broken behaviour
  forever defeat the purpose.
- **No claim that ANY of A' or B' works** until the corresponding
  C' probe is green.
- **No prod redeploy** until all A' / B' / C' waves complete and the
  cross-track verification wave is green.

---

## §6 Research findings → plan delta — 2026-05-08

After §3 was drafted, a research-first dispatch (R1-R6) ran against
public Cloudflare documentation and internal-pattern references.
Synthesis lives at `audit/sections/PROD-RESET-RESEARCH-SYNTHESIS.md`.
This §6 records the deltas to §3 + §4 the research mandates.

### §6.1 New facts that change framing

- **F.1** (R6.4 / Agents docs §"Why fibers exist"): DOs are evicted
  **1-2× per day** by routine code updates / runtime restarts. This
  is platform behaviour, not Nimbus's choice. Track B' is
  consequently NOT a "blast-radius mitigation" — it's a
  **platform-required correctness property**.

- **F.2** (R1.1 / DO Pricing footnote 5): The 128 MB cap is per-V8-
  isolate, not per-DO. Same-class peer DOs MAY co-tenant in one
  isolate, sharing 128 MB. Spawning peer NimbusSession DOs for
  parallelism does NOT give us isolated 128 MB envelopes.

- **F.3** (R5.2 / Cloudflare Containers GA): Containers exist as
  alternative architecture with 256 MiB-12 GiB+ memory per
  instance, fronted by a DO. They trivially solve Bug C's
  memory-pressure trigger. NOT pursued — product pivot.

- **F.4** (R6.4 / Agents docs example): The Agents framework's
  `runFiber` / `stash` / `onFiberRecovered` primitive is the
  platform-blessed pattern for "work that survives DO eviction".
  This is the pattern Track B' is reaching for.

- **F.5** (R6.5 / Service bindings limits): A single Worker
  invocation can fan out to at most **32 service-binding
  invocations**. Pre-bundle per-spec fan-out (the under-leveraged
  parallelism noted below) must stay within 32.

- **F.6** (R3.6 / Workers RPC): 32 MiB structured-clone cap is
  bypassed by ReadableStream-over-RPC. The platform-blessed way
  to ship >32 MiB through RPC is byte-streams.

- **F.7** (R2.5 / Dynamic Workers API): Using DIFFERENT IDs in
  `LOADER.get(id, …)` allows the platform to place each in a
  distinct V8 isolate with its own 128 MB. Same-ID stubs may
  also fan to multiple isolates but it's not guaranteed.

- **F.8** (R1.2.2 / DO Limits footnote 4): A DO that consumes
  >30 s of CPU between WS messages has a "heightened chance of
  eviction". This is a SECOND distinct eviction trigger we did
  not previously account for.

### §6.2 Track A' updates

- **A'.2 — REVISED**: instead of "stream pre-bundle slices via
  chunked RPC handle", use **ReadableStream-over-RPC** (F.6). The
  facet pulls bytes from a `SUPERVISOR.getSliceStream(spec)`
  ReadableStream return value. Built-in flow control. No 32 MiB
  cap. Platform-blessed pattern.

- **A'.NEW.6 — yield-to-event-boundary on long supervisor bursts**:
  per F.8, any supervisor compute that runs >25 s without
  awaiting an inbound boundary (WS message, HTTP fetch, alarm)
  is at risk of eviction. Add a yield-coordinator that breaks
  long bursts at safe checkpoints. Pre-bundle slot loop at
  `src/npm-installer.ts:1517-1750` is the prime offender.

- **A'.NEW.7 — per-spec-ID fan-out for pre-bundle**: per F.7,
  splitting N pre-bundle specs across N stubs (each with
  `prebundle:<spec>:<sliceHash>` ID) lets the platform place them
  in separate isolates. ~5-6 concurrent ceiling. Stay within 32
  service-binding-invocations cap (F.5). Tradeoff: more orchestration
  overhead vs better isolation. Verify post-Bug-B-fix.

- **A' framing note**: per the synthesis §S.2.1, the right metric
  is "supervisor never holds bulk allocations >1 MiB", NOT a
  numeric heap ceiling. The previous "≤ 64 MiB" target is
  dropped — see §6.4 gate-matrix update.

### §6.3 Track B' updates

- **B' framing — UPGRADED**: Track B' is platform-required
  correctness, not blast-radius mitigation. The user-visible
  symptoms of Bug C are downstream of routine 1-2×/day evictions
  even if memory pressure is zero. Track B' was originally
  proposed as elective; F.1 makes it mandatory.

- **B'.NEW.0 — adopt-or-reimplement the Agents fiber primitive**:
  `runFiber(name, cb)` registers a long-running task; `stash()`
  checkpoints; `onFiberRecovered(ctx)` resumes. Plan §3
  originally drafted "Phase R / B / W / O" for initSession; F.4
  recommends modelling this on the fiber primitive directly.
  - Long-running shell commands (`npm install`, `npm run dev`) =
    fibers.
  - Vite dev server = fiber.
  - Cwd / scrollback / env = regular SQL state, recovered via
    `ctx.storage.sql` reads on next initSession (not a fiber).

- **B'.5 — RECONFIRMED**: `/ws` 409-rejection at
  `src/nimbus-session-routes.ts:92-103` becomes a "join existing
  session" path. After fiber-style B', the live shell IS reusable
  across WS upgrades. The 409 was a defensive workaround for the
  recovery gap. Once recovery is correct, the gate can switch.

### §6.4 Gate matrix update — see §4.4 below

§4.4 has a fully-updated gate matrix in §6 below (the previous 5
gates → 8 gates after research). The numerical update of §4.4
itself follows in the next dispatch (R9).

### §6.5 Track D' (DO Facets migration) — DEFER

DO Facets (the public primitive `this.ctx.facets.get`, R3.4) are a
LONG-TERM target shape but not part of the immediate Bug C fix.
Track D' is a multi-wave migration that should follow A' / B' / C'
completion. Plan §3 references it for record but does not
schedule it.

### §6.6 Container migration — explicit decline

Cloudflare Containers (R5) trivially solve Bug C's memory-pressure
trigger. Plan §3 explicitly DOES NOT pursue this because:

- It's a product pivot from "Cloud-native dev env on workerd
  isolates" to "Cloud-native dev env on Linux containers".
- The strategic identity of Nimbus is the JS-isolate-based
  approach.
- Other players in the dev-env-on-cloud space all use containers;
  Nimbus's differentiation is the workerd-isolate approach.

If the strategic identity changes later, Containers remain the
trivial-fix path. Plan §5 is updated to record this.

### §6.7 Recommended NEW first build dispatch — Bug B fix

The previous plan §4 dispatch order is unchanged in shape. The
recommended FIRST build dispatch is **Bug B fix** (the heap
estimator). After Bug B, all subsequent waves can MEASURE their
effect against a real signal.

Specific scope for first dispatch:
- New file: `src/heap-estimate.ts`. Deterministic estimator
  function that sums known supervisor-heap allocation sources
  from constants (SLICE_CAP_BYTES, PRE_BUNDLE_CONCURRENCY, etc.)
  and the application-level counters from `src/diag-counters.ts`.
- Replace `readSupervisorHeap` at
  `src/npm-installer.ts:1936-1945` to call the new estimator.
- Surface `peakHeapEstimate` field in `/api/_diag/memory` v3
  alongside the always-zero `nodeMem`.
- ≤ 60 LoC. Zero behavioural change. Single test probe.

Gate 1 (heap estimator approach) must clear BEFORE this dispatch.
