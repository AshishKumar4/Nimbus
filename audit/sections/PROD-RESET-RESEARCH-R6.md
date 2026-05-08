# PROD-RESET-RESEARCH — R6: Internal patterns — Browser Rendering, Workflows, Agents

Research scope: how other Cloudflare-internal heavy-isolate workloads
(Browser Rendering, Workflows, Agents) handle the same memory-pressure
+ eviction-recovery problems Nimbus faces. Looking for established
patterns Nimbus could adopt.

---

## R6.1 Browser Rendering — runs Chromium in a separate fleet, NOT the Worker isolate

✓ CONFIRMED ([Browser Rendering binding](https://developers.cloudflare.com/browser-run/reference/wrangler/)):

```jsonc
{ "browser": { "binding": "MYBROWSER" } }
// In code:
const browser = await puppeteer.launch(env.MYBROWSER);
```

The Worker doesn't host Chrome. Chrome runs in a dedicated fleet
(presumably containers, similar to R5). The Worker speaks Chrome
DevTools Protocol over a WS connection. The Worker isolate stays
small (just routing + DevTools messages); the heavy work happens
in the browser fleet.

[Increased Browser Rendering limits — 2025-01-30](https://developers.cloudflare.com/changelog/post/2025-01-30-browser-rendering-more-instances/):

> Browser Rendering now supports 10 concurrent browser instances per
> account and 10 new instances per minute, up from the previous
> limits of 2.

**For Nimbus this is a TEMPLATE**: the Worker is a routing layer; the
heavy workload lives in a separate fleet primitive (browser /
container / dynamic Worker) addressable via a binding.

The pattern Nimbus is reinventing: instead of binding to a
platform-provided fleet, Nimbus is using `LOADER.get()` to spawn
"its own fleet" of dynamic Workers. Architecturally these are
similar, but the platform's primitives have been more rigorously
designed for the per-instance memory budget than Nimbus's
inside-supervisor orchestration.

❗ ARCHITECTURE-IMPACTING — Browser Rendering's 32 MiB WS message
limit (covered separately in R6.2) was raised from 1 MiB
specifically because Chrome DevTools Protocol messages can be large.
This is a **direct case study** of "platform raised the limit because
internal team needed it" — a precedent that suggests the 32 MiB cap
isn't an immutable hard ceiling.

---

## R6.2 32 MiB WebSocket message limit (raised 2025-10-31)

✓ CONFIRMED ([Workers WebSocket message size limit increased — 2025-10-31](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)):

> Workers, including those using Durable Objects and Browser
> Rendering, may now process WebSocket messages up to 32 MiB in
> size. Previously, this limit was 1 MiB.
>
> This change allows Workers to handle use cases requiring large
> message sizes, such as processing Chrome Devtools Protocol
> messages.

So WS messages and structured-clone RPC messages now share the same
32 MiB ceiling. This matters for Nimbus when shipping the LIFO
shell command output back over WS — terminal scrollback chunks
must stay under 32 MiB (already trivially true).

---

## R6.3 Workflows + Dynamic Workflows — durable execution model

✓ CONFIRMED ([Workflows](https://developers.cloudflare.com/workflows/)):

> Cloudflare Workflows provide a way to build and deploy applications
> that align with [the Durable Execution] model.

Architecture: each `step.do(...)` is a durable boundary. The runtime
persists step results to storage. If the underlying Worker isolate
is recycled mid-Workflow, the next invocation resumes from the last
completed step.

[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/):

> Workflows (per step) — Wall time limit: Unlimited. Each step can
> run for an unlimited wall time. Individual steps are subject to
> the configured CPU time limit.

So Workflows DECOUPLE long-running work from isolate lifetime. Each
step is a small isolate-bounded unit; the orchestration of the steps
is durable.

**Why this matters for Nimbus**: an `npm install` is conceptually a
multi-step Workflow:
- step 1: resolve dependency graph
- step 2: fetch tarballs
- step 3: extract + materialize
- step 4: pre-bundle

If we modelled npm install as a Workflow, each step would run in its
own bounded-CPU+memory isolate; the supervisor wouldn't need to
hold all four phases in memory simultaneously. Failures retry per
step (configurable backoff). Eviction mid-install resumes
gracefully.

[Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/):

> You can run a Workflow inside a Dynamic Worker to get durable
> execution for code that is loaded at runtime. Each step in the
> Workflow survives failures, can sleep for hours or days, can wait
> for external events, and resumes exactly where it left off — even
> if the isolate is recycled between steps.

So you can compose Dynamic Workers with Workflows for the
"untrusted code, durable execution" pattern. For Nimbus this is
overkill (we trust our own code); but the Workflows pattern alone
is a valid alternative architecture for npm install / pre-bundle.

---

## R6.4 Agents — fibers / `runFiber()` / `keepAlive()` for crash recovery

❗ MASSIVE FINDING.

[Agents — Durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/):

> Run work that survives Durable Object eviction. `runFiber()`
> registers a task in SQLite, keeps the agent alive during execution,
> lets you checkpoint intermediate state with `stash()`, and calls
> `onFiberRecovered()` on the next activation if the agent was
> evicted mid-task.

> ## Why fibers exist
>
> Durable Objects get evicted for three reasons:
>
> 1. **Inactivity timeout** — ~70-140 seconds with no incoming
>    requests or open WebSockets
> 2. **Code updates / runtime restarts** — **non-deterministic, 1-2x
>    per day**
> 3. **Alarm handler timeout** — 15 minutes

❗ ARCHITECTURE-IMPACTING — **Code updates / runtime restarts happen
1-2× PER DAY, non-deterministically**. This is a HARD platform fact
that plan §3 must accommodate.

Implications for Bug C:
- Even if Track A' eliminates memory-pressure-induced eviction
  entirely, **DOs WILL still get evicted at least 1-2× per day**.
- The user's reported "session became progressively laggy → DO
  reset" could be explained by EITHER memory pressure OR a routine
  runtime restart.
- Track B' (state persistence + recovery) is therefore NOT optional.
  No matter how clean Track A' makes memory, the recovery path
  WILL be exercised at least daily.

The fiber example:

```ts
class MyAgent extends Agent {
  async doWork() {
    await this.runFiber("my-task", async (ctx) => {
      const step1 = await expensiveOperation();
      ctx.stash({ step1 });
      const step2 = await anotherExpensiveOperation(step1);
      this.setState({ ...this.state, result: step2 });
    });
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "my-task") return;
    const snapshot = ctx.snapshot as { step1: unknown } | null;
    if (snapshot) {
      const step2 = await anotherExpensiveOperation(snapshot.step1);
      this.setState({ ...this.state, result: step2 });
    }
  }
}
```

This is **plan §3 Track B' as a platform primitive**:
- Register a long-running task with `runFiber`.
- Checkpoint intermediate state with `stash()`.
- On eviction-and-resume, `onFiberRecovered` is called with the
  snapshot. The handler resumes from there.

For Nimbus's session DO, the analogue would be:
- npm install → a fiber
- vite dev → a long-lived fiber that periodically checkpoints
- shell command execution → could be a fiber for long commands

The ✓ CONFIRMED Agents framework is part of Cloudflare's ecosystem
(`agents` npm package). Nimbus is NOT an Agent, but the fiber
primitive is generic — "DO eviction-resilient execution" — and we
could either:
1. Adopt the Agents framework wholesale (large rewrite).
2. Reimplement the fiber primitive in Nimbus, citing the Agents
   pattern as the design source.

(2) is what plan §3 was already drafting under Track B'. R6 just
confirms there's a battle-tested CF-internal pattern to reference.

---

## R6.5 Service binding fan-out cap (32 invocations per request)

✓ CONFIRMED ([Service bindings — Limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)):

> Service bindings have the following limits:
> * Each request to a Worker via a Service binding counts toward
>   your subrequest limit.
> * **A single request has a maximum of 32 Worker invocations**, and
>   each call to a Service binding counts towards this limit.
>   Subsequent calls will throw an exception.
> * Calling a service binding does not count towards simultaneous
>   open connection limits.

❗ ARCHITECTURE-IMPACTING for Nimbus:

A SINGLE supervisor request can fan out to at most **32 Worker
invocations** via service bindings. Nimbus's loopback service-
binding pattern (R3.7) means every dispatch through `ctx.exports.X(...)`
or `LOADER.get(...).fetch()` consumes one of these 32 slots.

For npm install (15 packages → 15 dispatches per phase × ≥3 phases =
~45 dispatches) we WOULD HAVE BEEN above this cap, except the
existing batch-facet design coalesces all 15 packages into ONE
dispatch (R5.6 / `src/npm-install-batch-facet.ts`). The batch-facet
pattern was the right choice — accidentally insulating us from the
32-invocation limit.

For pre-bundle: if we proposed in R2.5 to fan-out to 8 distinct
pre-bundle facets per request, we'd be using 8 of 32. Below the
cap but eats into our budget.

**Plan §3 Track A' implication**: be CAREFUL with the per-spec-ID
fan-out from R2.5. 32 is the hard cap per single request invocation.
Need to either keep batch-style consolidation or split a single
fan-out across multiple supervisor invocations.

This DOES NOT count toward the 6-simultaneous-headers cap (R2.8)
— that's a separate counter for raw connections. So the Worker
invocations cap is the actual fan-out ceiling.

---

## R6.6 Workers AI — managed inference fleet

⚠ UNVERIFIED specific architecture, but the pattern is clear from
public docs ([Workers AI](https://developers.cloudflare.com/workers-ai/)):

> Workers AI runs machine learning models on the Cloudflare global
> network from your code via REST API or directly from your Workers.

Workers AI is bound via `env.AI.run(...)`. The Worker doesn't host
the model. The model runs in a managed inference fleet
(Workers AI servers).

Same pattern as Browser Rendering: the Worker is a thin routing
layer; the heavy compute runs in a dedicated fleet.

**For Nimbus**: there's no parallel — Nimbus's "model" is the LIFO
JS Kernel, which we host ourselves in workerd isolates. Could
arguably be replaced with a "Nimbus-Kernel-as-a-Service" backed
by containers (R5.7), but that's the strategic pivot we already
declined.

---

## R6.7 Queues + Workflows for fan-out

✓ CONFIRMED ([Browser Rendering queue example](https://developers.cloudflare.com/changelog/post/2025-01-30-browser-rendering-more-instances/)):

```js
export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const browser = await puppeteer.launch(env.BROWSER);
      // ...
    }
  },
};
```

The pattern: for fan-out beyond what a single Worker invocation
can handle (32 service-binding invocations OR 6 simultaneous
headers OR 5-6 dynamic-isolates ceiling), use Queues to enqueue
the work and a separate consumer Worker to process each item.

For Nimbus's npm install (15 packages):
- Today: one batch-facet handles all 15 in a single dispatch
  (R6.5 — coalesced).
- Alternative: enqueue 15 messages to a Queue, consumer Worker
  processes each in its own invocation. Each gets fresh limits
  budget.

The cost: Queue messages are persisted to disk; latency per
message is ~10s of ms. For an interactive npm install this adds
noticeable latency. ❌ Probably wrong tradeoff for Nimbus.

For BACKGROUND work (e.g. R2 cache warming, log cleanup), Queues
are appropriate. For interactive paths, stay synchronous.

---

## R6.8 R6 summary — what changes for plan §3

| Pattern | R6 finding | Plan §3 implication |
|---|---|---|
| Browser Rendering: heavy work in separate fleet | ✓ Established CF-internal pattern | Plan §3's Track A' direction (move heavy work out of supervisor) is consistent with this |
| Workflows: durable per-step execution | ✓ GA primitive for "outlive isolate restarts" | Track B' could be modelled on Workflows; would simplify the recovery code path |
| Agents: `runFiber` / `stash` / `onFiberRecovered` | ❗ Direct match for Track B' | Plan §3 should explicitly reference the Agents fiber primitive as design source. Either adopt or reimplement. |
| **DO eviction is 1-2× per day baseline** | ❗ HARD PLATFORM FACT | Track B' is NOT optional. Even with Track A' eliminating memory pressure, eviction WILL happen daily. |
| 32 Worker invocations per request | ✓ CONFIRMED hard cap | Per-spec-ID fan-out (R2.5) must stay within 32. Batch-facet pattern was right. |
| 32 MiB WS message size | ✓ Raised from 1 MiB in 2025-10-31 | No new design constraint; useful headroom |
| Queues for batch fan-out | ✓ Pattern exists | NOT for interactive paths (latency); use for background work |

**Major plan §3 update from R6**:

1. Track B' direction is **NON-NEGOTIABLE** because of R6.4 — DOs
   evict 1-2× per day even without our memory pressure. Plan §3
   originally framed B' as "blast-radius mitigation"; R6.4 says
   it's actually "platform-required correctness".

2. Track B' should explicitly reference the **Agents `runFiber`
   primitive** as a known-good design pattern. Specifically:
   - `runFiber('install', cb)` for npm install — survives DO restart.
   - `runFiber('pre-bundle', cb)` for the pre-bundle pool.
   - `runFiber('vite-dev', cb)` for the long-lived vite server.
   - `stash()` / `onFiberRecovered()` for checkpoint state.

3. The pre-bundle per-spec fan-out (R2.5) is bounded at 32 per
   single request. Must coalesce or batch in chunks of ≤32.

4. WS message size is no longer a constraint (32 MiB ≥ everything
   we'd ship per WS message).

---

## R6.9 Open follow-ups

⚠ UNVERIFIED:
- Whether Nimbus's CURRENT architecture HAS been hit by the 1-2×
  daily eviction baseline. The user reported "DO reset
  mid-session" — this could be the routine 1-2x/day eviction NOT
  caused by us. Verifying this requires longer-window prod tail
  capture (a Track C' deliverable).
- Whether the Agents framework (`agents` npm package) is usable
  standalone or requires being inside an Agent class. The
  `runFiber` primitive is described in the Agent context; need
  to check whether the same primitive is available bare.
- Whether `step.do()` from Workflows is usable inside a regular
  DO (not a WorkflowEntrypoint). Public docs imply only inside
  WorkflowEntrypoint, but worth verifying.

These resolve in follow-up research or empirically post-Bug-B fix.
