# Section F — Observability

> Researched against `wiki.cfdata.org` (Workers Observability + Tail Workers + DO Observability), `developers.cloudflare.com/workers/observability/`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — observability levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **F1** | Add `cause` discriminator to `/api/_diag/memory` (per-OOM, per-RPC-fail, per-facet-evict, per-clone-refusal); persist last snapshot on `webSocketClose` | Cuts MTTR on user-reported "session vanished" reports from minutes-of-guesswork to a single grep | XS |
| **F2** | Enable Workers Logpush + Workers Trace Events for the supervisor script | Off-platform structured-log archive of every install / git / node invocation. ~$0.05/MM-requests | S |
| **F3** | Adopt platform Tail Workers for the supervisor (already supported) — replace half of `process-logs.ts` with platform fan-out | Saves ~150 LOC; gives users a familiar `tail` consumer pattern | S |
| **F4** | Set up Analytics Engine binding for npm-install telemetry (per-install duration, per-package size, miss/hit rates) | Real measurements instead of synthetic benchmarks; informs Levers D1, D2 | S |
| **F5** | Wait for Dynamic Workers Observability RFC (Section B Lever B2); when it lands, delete most of `process-logs.ts` | -300 LOC eventually; first-class facet logs | M (gated) |
| **F6** | Add OpenTelemetry tracing to Nimbus's supervisor — pattern from Waiting Room (WR-1069); use `OBS` wiki link `OBS/How To: Add OpenTelemetry tracing to your service` | Distributed traces across supervisor → facet → R2 → registry | M |

F1 and F2 are immediate. F4 (analytics) is the prerequisite for measuring Levers D1/D2 effectiveness.

---

## F.1 What `/api/_diag/memory` should also surface

[`src/diag-counters.ts`](../../src/diag-counters.ts) is the file holding application-level memory + phase observability:

```
// 2: diag-counters.ts — application-level memory + phase observability.
// 4: Why: workerd's `process.memoryUsage()` returns 0 for all fields inside
// 16: the request handler in nimbus-session.ts:/api/_diag/memory can read
// 23: Phase tags surfaced via /api/_diag/memory. Strings are ASCII so
```

Today the diag payload includes phase tags + counters but not the *cause* of failures. Concretely missing:

| Signal | What it diagnoses | Source today |
|---|---|---|
| Last OOM cause | `condemnation`/`hard-evict`/`SQLITE_NOMEM`/`clone-refused` | Nothing — we don't catch these |
| Per-facet RSS estimates | Heap pressure inside facet vs supervisor | Facet RPC returns count but not delta |
| In-flight RPC bytes | Live structured-clone load | Nothing |
| Last close time + cause per WS kind | "shell terminated due to X" | Nothing |
| LRU hit/miss counters for SqliteVFS | Page-cache effectiveness | Internal but not surfaced |

### Lever F1 — concrete patch

Augment [`src/diag-counters.ts`](../../src/diag-counters.ts) with a `lastFailure` slot:

```ts
// audit-only sketch
+ export interface DiagFailure {
+   at: number;            // Date.now()
+   phase: string;          // 'install', 'resolve', 'pre-bundle', etc.
+   cause: 'oom' | 'sqlite_nomem' | 'clone_refused' | 'rpc_timeout' | 'subrequest_cap' | 'unknown';
+   rssEstimateBytes: number;
+   lruBytes: number;
+   inFlightBytes: number;
+   message?: string;
+ }
+ const lastFailures: DiagFailure[] = [];   // ring buffer, last 50
+ export function recordFailure(f: DiagFailure) { lastFailures.unshift(f); if (lastFailures.length > 50) lastFailures.pop(); }
+ export function getLastFailures() { return lastFailures.slice(0, 50); }
```

Wire from:

- [`src/parallel/facet-pool.ts:99-104`](../../src/parallel/facet-pool.ts) (clone-refused detection — currently swallowed)
- [`src/heavy-alloc-coord.ts`](../../src/heavy-alloc-coord.ts) (heap-pressure entry/exit)
- [`src/npm-installer.ts:1219-1289`](../../src/npm-installer.ts) (post-Lever A3 SQLITE_NOMEM catch)
- [`src/nimbus-session.ts:3813-3878`](../../src/nimbus-session.ts) (webSocketClose / Error)
- [`src/facet-manager.ts:805-820`](../../src/facet-manager.ts) (facet RPC failure)

Surface via the existing `/api/_diag/memory`:

```ts
// src/index.ts (audit-only sketch — augment existing handler)
  if (url.pathname === '/api/_diag/memory') {
    return Response.json({
      vfs: { totalBytes, totalFiles, lruBytes, hotPages },
      process: { ... },
+     lastFailures: getLastFailures(),
+     facetPool: { activeFacets, queuedRpcs, rcpInFlightBytes },
+     rpc: { inFlightCount, lastCloneRefusalAt, totalSerializedBytesToday },
    });
  }
```

Net: every `cf-tail` of a Nimbus failure has a "your session crashed because (cause), here's what was in flight" trace.

### F.1.1 Surfaceable as user-facing diag

Extend `/api/processes` (the existing endpoint) to include a per-process `lastError` slot from the same ring buffer, filtered by pid. Users running `npm install` and seeing a hang can now run `curl /api/processes` and read the actual cause. ~50 LOC.

---

## F.2 Workers Logpush + Workers Trace Events

### F.2.1 What's documented

Per [Workers Observability ↗](https://wiki.cfdata.org/pages/viewpage.action?pageId=906857050) and [PRD: Workers Logpush GA](https://wiki.cfdata.org/display/EW/PRD%3A+Workers+Logpush+GA):

> *"Workers customers use Logpush to ship logs to a common destination such as R2, S3, Datadog, Sentry, or Coralogix."*

> *"Pricing: This is a paid product. Workers Logpush is priced at $0.05/MM requests for both Ent and Workers Paid plan customers."*

For Nimbus, "1 request" = 1 supervisor `fetch()` call. Even at 10 RPS sustained, that's 864k requests/day = **~$0.04/day for Logpush**. Trivial.

### F.2.2 The Trace Event format

Per [Sven/Log better from Workers with Logpush](https://wiki.cfdata.org/spaces/~sven/pages/651244298/Log+better+from+Workers+with+Logpush):

```json
{
  "Event": { "RayID": "...", "Request": {...}, "Response": {...} },
  "EventTimestampMs": ...,
  "EventType": "fetch",
  "Exceptions": [],
  "Logs": [{"Level": "log", "Message": ["..."], "TimestampMs": ...}],
  "Outcome": "ok",
  "ScriptName": "nimbus",
  "ScriptTags": []
}
```

Critically: `console.log({ "cloudflare.account_id": 1, "tag": 2, "message": "yes" })` from inside the worker shows up structured in Logpush. Nimbus's existing logs (the `[nimbus]` prefixed `console.log` calls scattered through src/) all land in this stream automatically once enabled.

### F.2.3 Lever F2 — concrete

```jsonc
// wrangler.jsonc (audit-only sketch)
{
+ "logpush": true,
}
```

Then provision a Logpush job to R2 via API. ~10 minutes of setup. **Free observability** of every request.

For the npm-install pipeline specifically, augment the existing log calls with structured fields:

```ts
// audit-only — pattern only, not specific files
- console.log(`[nimbus] install ${name}@${version} ok`);
+ console.log({ event: 'npm.install.ok', name, version, durationMs, tarballBytes, source: 'r2' });
```

Then a Logpush filter on `event:npm.install.ok` produces an actionable per-install dataset for Lever F4 (Analytics).

---

## F.3 Tail Workers for the supervisor

### F.3.1 What Tail Workers are

Per [EW/Tail Workers](https://wiki.cfdata.org/display/EW/Tail+Workers):

> *"Tail workers are a general purpose solution for consuming logs from Workers of all event types via forwarded events to a consuming Worker. Once script execution on the 'producer' has completed, logs, exceptions, and event trigger information are forwarded to the consumer, which is then able to process as they see fit."*

Configuration:

```jsonc
// audit-only sketch
{
  "tail_consumers": [{ "service": "<TAIL_WORKER_NAME>", "environment": "production" }]
}
```

The tail handler:

```ts
export default {
  async tail(events: TraceItem[]) {
    for (const evt of events) {
      // ship to wherever
    }
  }
}
```

### F.3.2 What Nimbus does today (and shouldn't keep doing)

[`src/process-logs.ts`](../../src/process-logs.ts) is ~309 LOC of in-memory ring-buffer log capture, with per-process keying via `proc-<pid>`. [`src/process-logs-api.ts`](../../src/process-logs-api.ts) is the WS-tail surface for it.

Pattern: facet `console.log` → `SUPERVISOR.write()` RPC → in-memory ring → WS subscribers.

This is **exactly** the Tail Worker pattern, hand-rolled. Once the [Dynamic Workers Observability RFC](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) ships (Lever B2 from Section B), the platform will deliver this for free.

### F.3.3 Interim: Nimbus-as-its-own-tail-consumer

Until the RFC GAs, Nimbus can already use Tail Workers for the supervisor. Set up a tail consumer that ships to R2 (or Datadog, etc):

```jsonc
// wrangler.jsonc
+ "tail_consumers": [{ "service": "nimbus-tail", "environment": "production" }]
```

Tail worker code (separate small worker):

```ts
// nimbus-tail/src/index.ts (audit-only sketch — separate script)
export default {
  async tail(events: TraceItem[], env: Env, ctx: ExecutionContext) {
    for (const evt of events) {
      ctx.waitUntil(env.NIMBUS_LOGS.put(
        `tail/${evt.scriptName}/${evt.eventTimestamp}-${crypto.randomUUID()}.json`,
        JSON.stringify(evt),
      ));
    }
  }
};
```

Net: durable archive of every supervisor invocation. ~30 minutes of work. After Section B's Lever B2 lands, this becomes **automatic** for facets too.

---

## F.4 OpenTelemetry in DOs — the Waiting Room precedent

### F.4.1 The pull thread

[WR-1069](https://jira.cfdata.org/browse/WR-1069) "Set up tracing for Waiting Room":

> *"We want to be able to see details of what happens for a request that goes through waiting room (subrequests, how long they took): https://wiki.cfops.it/display/OBS/How+To%3A+Add+OpenTelemetry+tracing+to+your+service"*

Status: **Needs Triage**, opened 2022-10-13, last updated 2024-03-09. Linked to WR-1106 ("flame-common library so that we can get rid of stats-actor and stats-collector entirely") and WR-1343 ("profile globalSync and see how the memory blows up to 135Mb").

Read: **WR-1069 has been parked for 2+ years.** OpenTelemetry in DOs is *desired but not turnkey*. ⚠️ speculation: this may be because [`OBS/How To: Add OpenTelemetry tracing`](https://wiki.cfops.it/display/OBS/How+To%3A+Add+OpenTelemetry+tracing+to+your+service) targets first-party Cloudflare services, not customer Workers, and DO-side wiring is non-trivial.

### F.4.2 Public docs path

Public docs ([Cloudflare Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)) describe automatic tracing for Workers but [Known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/) (per the RFC reference) state:

> *"service bindings and Durable Objects appear as separate traces rather than nested spans"*

So today, supervisor → facet RPC traces appear as **separate** traces, not parent/child. This is exactly what hampers Nimbus debugging.

### F.4.3 Lever F6 — pre-emptive OpenTelemetry layer

Even before WR-1069 / Dynamic Workers Observability ship, Nimbus can add an OTel layer manually:

```ts
// src/_shared/otel.ts (audit-only sketch)
export class NimbusTrace {
  static span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const traceId = (globalThis as any).__nimbusTraceId ??= crypto.randomUUID();
    const spanId = crypto.randomUUID();
    return fn().then(
      (r) => { console.log({ otel: 'span.end', name, traceId, spanId, durationMs: performance.now() - start, status: 'ok' }); return r; },
      (e) => { console.log({ otel: 'span.end', name, traceId, spanId, durationMs: performance.now() - start, status: 'error', error: e?.message }); throw e; },
    );
  }
}
```

Used at every RPC boundary:

```ts
// src/supervisor-rpc.ts
async writeBulkFromTar(prefix: string, tarStream: ReadableStream<Uint8Array>) {
  return NimbusTrace.span('SUPERVISOR.writeBulkFromTar', async () => {
    // ... existing logic
  });
}
```

Combined with Lever F2 (Logpush), the spans land in the trace events stream. Tools like Datadog or Jaeger that consume Logpush via OTLP receive structured spans.

When [WR-1069 / OpenTelemetry-in-DOs](https://jira.cfdata.org/browse/WR-1069) ships natively, Nimbus's `NimbusTrace.span` calls become a thin wrapper over the platform API. Effort: M, ~150 LOC.

---

## F.5 Analytics Engine for npm-install telemetry

### F.5.1 What it is

Per the Workers Bindings page ([developers.cloudflare.com/workers/runtime-apis/bindings/](https://developers.cloudflare.com/workers/runtime-apis/bindings/)):

> *"Analytics Engine"* — listed as a binding type. The product page is at [analytics/analytics-engine](https://developers.cloudflare.com/analytics/analytics-engine).

Conceptually: a high-cardinality, append-only column-store with SQL queries via REST. Time-series data point format `(timestamp, blob[], double[], index[])`. Cheap to write, queryable.

### F.5.2 Lever F4 — npm-install metrics

```ts
// src/npm-installer.ts (audit-only sketch)
- console.log(`[nimbus] install ${name}@${version} ok in ${durationMs}ms`);
+ env.INSTALL_METRICS.writeDataPoint({
+   blobs: [name, version, source /* 'r2' | 'cache-api' | 'origin' */, source === 'origin' ? 'cold' : 'warm'],
+   doubles: [durationMs, tarballBytes],
+   indexes: [tenantId],
+ });
```

`wrangler.jsonc`:

```jsonc
{
+ "analytics_engine_datasets": [
+   { "binding": "INSTALL_METRICS", "dataset": "nimbus_install_metrics" }
+ ]
}
```

After a week of data, queries like:

- *"What's the p99 duration of installing react@latest in the last hour?"*
- *"What's the cache-hit rate by package by region?"*
- *"Which 100 packages cost us the most cumulative install time?"*

These directly inform Levers D1, D2, D5 effectiveness.

⚠️ caveat: Analytics Engine has free tier limits. For Nimbus's scale, well within free tier. Re-check at scale.

---

## F.6 What we're NOT doing

- **Build a Sentry integration in-tree.** Use Logpush → Sentry destination. ~10 minute setup; no code change.
- **In-DO time-series storage.** SQLite VFS is for user files, not telemetry. Analytics Engine is the right tool.
- **Reinvent Workers Logs.** Workers Logs (the dashboard product) and Logpush share the same pipeline — enabling Logpush gets both.

---

## F.7 Concrete diff, prioritised

### Lever F1 — diag-counters.ts ring buffer (XS)

See §F.1.1 sketch. ~80 LOC.

### Lever F2 — enable Logpush (S)

```jsonc
// wrangler.jsonc
+ "logpush": true,
```

Plus structured logging refactor in install/git/facet code. ~50 LOC across multiple files, all `console.log` → `console.log({event, …fields})`.

### Lever F3 — Tail Worker (S)

Separate `nimbus-tail` worker, ~50 LOC, configured via `tail_consumers`.

### Lever F4 — Analytics Engine (S)

Add binding + datapoint writes at install boundaries. ~60 LOC.

### Lever F5 — wait for Dynamic Workers Observability (M, gated)

When it ships: delete `src/process-logs.ts` ad-hoc store, route to platform.

### Lever F6 — OpenTelemetry layer (M)

`src/_shared/otel.ts`, span calls at RPC boundaries. ~150 LOC.

---

## F.8 Citations summary

Wiki:
- Workers Observability/👋 Hello, Workers Observability
- EW/SPEC: Workers Trace Events are available in Logpush
- EW/PRD: Workers Logpush GA
- EW/FAQ: Logpush for Workers Trace Events
- EW/Tail Workers
- ~birvine-broque/[RFC] Dynamic Workers Observability
- ~sven/Log better from Workers with Logpush
- DES/Design Doc: Durable Objects Observability
- WR/Waiting Room Observability
- WR/Waiting Room TroubleShooting (Sentry workflow)

Jira:
- WR-1069 — Set up tracing for Waiting Room (still Needs Triage as of 2024-03-09)
- Linked WR-1106, WR-1343

Public docs:
- developers.cloudflare.com/workers/observability/logs/workers-logs/
- developers.cloudflare.com/workers/observability/logs/tail-workers/
- developers.cloudflare.com/workers/observability/traces/
- developers.cloudflare.com/workers/observability/traces/known-limitations/
- developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- developers.cloudflare.com/analytics/analytics-engine/
- developers.cloudflare.com/workers/runtime-apis/bindings/

Nimbus src/ citations:
- `src/diag-counters.ts:1-239` (existing diag surface)
- `src/index.ts` `/api/_diag/memory` handler
- `src/process-logs.ts:1-309` (custom tail re-implementation)
- `src/process-logs-api.ts:21-23` (custom WS tail)
- `src/heavy-alloc-coord.ts` (alloc-pressure signal — natural ring-buffer source)
- `src/parallel/facet-pool.ts:99-104` (clone-refusal — Lever F1 wire-up site)
- `src/facet-manager.ts:805-820` (facet RPC failure — Lever F1 wire-up site)
- `src/nimbus-session.ts:3813-3878` (webSocketClose — Lever F1 wire-up site)
- `src/supervisor-rpc.ts` (RPC boundary — Lever F6 span site)
