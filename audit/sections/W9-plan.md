# W9 — Hibernatable process logs + WS auto-response — PLAN

> Wave: W9 (Phase 2)
> Branch: `w9-hib-logs`
> Status: Phase A — plan, sub-agent reviewed
> Sources: [CF-INTERNAL-OPTIMIZATION-RESEARCH.md §C](./CF-INTERNAL-OPTIMIZATION-RESEARCH.md), [STOR/Durable Objects WebSocket Primer](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem), [/durable-objects/api/state/#setwebsocketautoresponse](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse), [/durable-objects/api/state/#sethibernatablewebsocketeventtimeout](https://developers.cloudflare.com/durable-objects/api/state/#sethibernatablewebsocketeventtimeout), [W5-retro.md](./W5-retro.md)

---

## 1. Problem statement

Two concrete bugs visible to the user; one billing/co-residency lever:

1. **Process-log loss across DO hibernation.** `ProcessLogStore` (`src/process-logs.ts:26-30`) is in-memory only — its `pids` Map dies with the isolate. The `// Non-goals` comment explicitly says "logs lost on hibernate, acceptable because hibernation is rare" — that assumption is wrong. Mossaic and `npm run dev` users routinely walk away for an hour, the DO hibernates, they reconnect → the `logs <pid>` ring buffer is empty, the `_emitExitDump` machinery has nothing to dump, and recently-buffered stderr (the actually useful crash context) is gone.

2. **Process-logs WS pins the DO.** `process-logs-api.ts:21-26` chose `server.accept()` (non-hibernatable) by design. Per the CF WebSocket Primer, that pins the actor — a long-lived log-tail tab keeps the DO awake forever, increasing co-residency pressure on every other tenant in the isolate (Section A.1 of the research doc).

3. **Idle-tab pings wake the DO.** Vite HMR clients ping every 30 s; idle xterm tabs ping per minute. Without `setWebSocketAutoResponse`, every ping pulls the actor out of hibernation: ~2880 wakes/day per idle tab. Each wake is billable duration plus a chance to reset the OOM budget right when a co-resident facet was about to peak. Auto-response config **survives hibernation** (Primer: "Survives: Auto-response configuration"), so set once in the constructor and forget.

## 2. Current state — process-logs persistence model

### 2.1 Data flow (today)

```
facet stdout/stderr  →  SupervisorRPC (RPC frame)  →  NimbusSession._rpcStdout/_rpcStderr
                                                     │
                                                     ├─ this.terminal.write(data)         ← live paint
                                                     └─ this.processLogs.append(pid, …)   ← in-memory ring
```

`ProcessLogStore.append` writes into a `Map<pid, PidState>` held by the `NimbusSession` instance. Nothing flushes through to `ctx.storage`. On hibernate the isolate is GC'd; the Map is GC'd with it.

### 2.2 Hibernation event flow

Per the Primer:

| Survives | Doesn't survive |
|---|---|
| `kj::WebSocket` network conn (recoverable as new `api::WebSocket` per dispatch) | All JS in-memory state |
| Serialized attachment (only via `serializeAttachment()`) | `api::WebSocket` objects (only the backing `kj::WebSocket` survives) |
| WebSocket tags | `addEventListener()` listeners (must use exported handlers) |
| Auto-response configuration | IoOwn-ed objects; non-serialized attachment data |

Concretely:
- The DO instance is destroyed during hibernation. A fresh constructor runs on next dispatch. `private processLogs: ProcessLogStore = new ProcessLogStore();` re-runs → new empty Map.
- Anything we want to survive must be in `ctx.storage` (KV) or `sql` (rows) before the last dispatch returns.
- The exported handlers (`webSocketMessage`, `webSocketClose`, `webSocketError`) ARE invoked across hibernation/wake; the event handler's `this` is a fresh instance.

### 2.3 Where logs disappear (specific lines)

- `src/process-logs.ts:26-30` — explicit non-persistence comment. The Map is the sole store.
- `src/nimbus-session.ts:479` — `private processLogs: ProcessLogStore = new ProcessLogStore();` — field init runs on every fresh isolate.
- `src/nimbus-session.ts:837, 852, 873, 877, 993, 995, 3178, 3201` — every `append`/`markExit` site writes only to in-memory state. None gate on ctx.waitUntil or sql.
- `src/process-logs-api.ts:100` — `server.accept()` (non-hibernatable). Even if we persist the ring, an active log tab still pins the actor and prevents the hibernation we want it to survive.

### 2.4 The W5 OOM ring is the precedent

W5 already solved an analogous problem for the OOM-discriminator ring: `_w5RehydrateRingFromStorage()` (`nimbus-session.ts:1776`) on init, `_w5PersistRing()` on close (`:1786`), `ctx.waitUntil`-gated (`:4039`). We mirror that pattern for process logs but with a smaller per-pid blob and incremental writes.

## 3. Target architecture

### 3.1 Persistence model (process logs)

**Store:** SQLite-backed `ctx.storage.sql`. We already have a `SqlStorage` available (W5 uses KV; we'll use SQL because (a) per-pid rows let us evict cheaply, (b) the W5 ring is one logical blob — process logs are N pids × M chunks, far worse for KV; (c) workerd's SQLite DOs already store the inode/file-chunks tables here, the engine is warm).

Schema (one table, additive — no migration of existing tables):

```
CREATE TABLE IF NOT EXISTS w9_proc_logs (
  pid          INTEGER NOT NULL,
  seq          INTEGER NOT NULL,        -- monotonic per-pid append index
  ts           INTEGER NOT NULL,        -- ms epoch
  stream       TEXT NOT NULL,           -- 'stdout' | 'stderr'
  data         TEXT NOT NULL,
  binary       INTEGER NOT NULL,        -- 0 | 1
  PRIMARY KEY (pid, seq)
);
CREATE INDEX IF NOT EXISTS w9_proc_logs_ts ON w9_proc_logs(ts);

CREATE TABLE IF NOT EXISTS w9_proc_exits (
  pid     INTEGER PRIMARY KEY,
  code    INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  reason  TEXT
);
```

**Why SQL not KV blob:**
- Eviction is `DELETE FROM w9_proc_logs WHERE pid = ?` — O(rows for that pid), not O(all-pids-ever-touched).
- Tail query `SELECT … WHERE pid = ? ORDER BY seq DESC LIMIT N` is index-friendly.
- A pid's rows are removed via `dropOlderThan` (already exists for in-memory) plus an SQL `DELETE` — no read-modify-write of a giant blob.

**Write path — alarm-driven flush (NOT write-through):**

Synchronous SQL writes from every `append()` would (a) blow up DO IO budget on a chatty `npm run dev` (vite emits ~50 lines/sec on hot reload), (b) push every write into the storage cache write-back queue. Instead:

```
append()  →  in-memory ring (existing behaviour, fast)
          →  mark `_dirty[pid] = true`, `_dirtyChunkCount[pid]++`
          →  if !_flushScheduled and total dirty chunks ≥ 32 OR oldest dirty > 1 s
                → ctx.storage.setAlarm(now + 250 ms) (debounced)
```

The DO `alarm()` handler runs `_w9FlushDirty()` — INSERTs all buffered chunks since last flush in a single `transactionSync`, then clears dirty markers. Alarm time is in the future even if it fires immediately, so wakes don't contend with the request handler.

**Crucial:** flush must also run on `webSocketClose` / `webSocketError` (mirroring W5 `_w5SafePersistRing`), gated on `ctx.waitUntil`. That guarantees logs land before the actor goes idle. The alarm is the steady-state janitor; close is the safety net.

**Read path — rehydrate on first access after wake:**

```ts
class ProcessLogStore {
  // Same in-memory API, plus:
  private _persist: PersistAdapter | null = null;   // injected from NimbusSession
  setPersist(p: PersistAdapter): void { this._persist = p; }
  /** Lazy: pull rows from SQL into in-memory ring on first append/tail/all/has for this pid */
  private _hydrate(pid: number): void { … }
}
```

`PersistAdapter` is a small interface (`load(pid)`, `flush(dirtyPids, getChunks)`, `dropPid(pid)`) implemented by NimbusSession with closures over `ctx.storage.sql`. Injecting an adapter keeps `ProcessLogStore` testable in Node (no SqlStorage dependency).

Hydration triggers:
- `tail(pid)`, `all(pid)`, `snapshot(pid)`: pull all rows for that pid into the Map BEFORE answering. Cap pull at the same `perPidBytes` cap (64 KB) — no need to drag more.
- `subscribe(pid)`: hydrate first so the new subscriber's first-frame backlog includes pre-hibernate data.
- `append(pid)`: if `pids.get(pid)` doesn't exist, hydrate first so the in-memory bytes counter is correct after a wake (else eviction logic miscounts).

A single `_hydratedPids: Set<number>` tracks which pids we've already pulled for this isolate, avoiding re-reads.

Eviction:
- `dropOlderThan` → also `DELETE FROM w9_proc_logs WHERE pid = ?` for purged pids (mirrored in adapter `dropPid`).
- `_evict` (per-pid byte cap): when chunks shift out of the in-memory ring, the corresponding rows are also deleted (`DELETE … WHERE pid = ? AND seq < ?`). Done in the same alarm-driven flush.
- Global cap (`maxPids`): same — cascade-delete the evicted pid's rows.

### 3.2 Hibernatable process-logs WebSocket

`process-logs-api.ts:100` switches to `ctx.acceptWebSocket(server, ['process-logs'])`, with `server.serializeAttachment({ kind: 'process-logs', pid })`. Then `webSocketMessage`, `webSocketClose`, `webSocketError` need to discriminate on `kind === 'process-logs'`:

- `webSocketMessage`: today the existing handler routes by attachment kind — adding a third case is trivial. Process-logs clients are output-only (the file's existing comment confirms it), so we just ignore inbound frames.
- `webSocketClose`: detach subscribers if any. The fresh-instance contract means subscribers from before hibernation don't exist anymore — closes during hibernation just need the storage row cleanup (none needed; subscribers are in-memory only).
- `webSocketError`: mirror close.

A wake-up sequence:
1. Client sends a frame on a previously-hibernated process-logs WS (or one is closed).
2. `webSocketMessage`/`webSocketClose` runs on a fresh `NimbusSession`.
3. Handler reads `pid` from `serializeAttachment` (survives), confirms `processLogs.has(pid)` (now backed by the SQL hydration path), and either resumes streaming or closes cleanly.

For the live-stream resume case, today's protocol opens a fresh subscription per WS open. After hibernation a client typically reconnects via a new WS anyway (browsers auto-reconnect dead WSes). We do NOT need to "resurrect" the in-memory subscription across hibernation — the client's reconnect triggers a new `handleLogsWebSocketRequest` flow which sends a fresh `backlog` frame from the now-hydrated ring. **This is the simpler design** and is consistent with the Primer's stance that JS handlers re-run on wake.

### 3.3 WS auto-response

In NimbusSession constructor (after `super(ctx, env)`):

```ts
try {
  this.ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair('ping', 'pong'),
  );
  this.ctx.setHibernatableWebSocketEventTimeout(
    NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS,
  );
} catch (e: any) {
  // Fail-soft: workerd builds before 2024-08 don't expose these APIs.
  // Log once and continue — non-fatal, just no auto-pong / no timeout.
  console.warn('[nimbus/W9] WS auto-response setup failed:', e?.message);
}
```

Note: `WebSocketRequestResponsePair` is a workerd global (per [public docs](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse), available since 2024-08). Wrap in try/catch in case the runtime predates it.

**Idle threshold tuning (`setHibernatableWebSocketEventTimeout`):**

Default is undocumented (per CF research §C.3). Goal: bound a single hibernation event so no one bad shell command holds the DO indefinitely.

Options considered:
- 1 s — too tight; legitimate `webSocketMessage` paths (terminal RPC dispatch, HMR routing) already hit 100-300 ms ranges.
- **5 s — recommended in CF research §C.3 / J.3.1.** Exactly what the research doc calls for. Long-running work belongs in facets (which have their own CPU budget); the supervisor's WS handlers should be enqueue-only.
- 30 s — too lax; blocks the wake-OOM-recovery window we want for co-residency.

→ Pick **5 s**. Document the rationale inline. Surface as `NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS = 5_000` in `src/constants.ts` so future tuning happens in one place.

### 3.4 Telemetry — hibernation-cycle observability

W5 added `lastFailures` ring + `peak` to `/api/_diag/memory`. W9 adds:

```ts
// src/diag-counters.ts (new counters; existing module preferred over a new file)
export interface HibCounters {
  // Counts since the LAST init (i.e., this isolate generation).
  isolateGen: number;          // monotonic across hibernate/wake; persisted in storage
  bootedAt: number;            // ms epoch — when this isolate started
  rehydratedPids: number;      // # pids whose log rows we pulled from SQL this gen
  rehydratedChunks: number;    // total chunks pulled
  rehydratedBytes: number;     // bytes pulled
  flushedChunks: number;       // chunks written via alarm flush this gen
  flushedBytes: number;
  flushCount: number;          // # times the alarm flush ran
  lastFlushAt: number;         // ms epoch
  lastFlushDurationMs: number;
  autoResponseConfigured: boolean;
  autoResponseConfiguredAt: number;
  hibernationEventTimeoutMs: number;
}
```

Exposed at `/api/_diag/memory` under a new `hib:` key (additive; W5 fields preserved). `isolateGen` is incremented in the constructor and persisted to `ctx.storage.put('w9_isolate_gen', n+1)` so we can SEE that hibernation/wake actually happened across requests — any monitoring run can read the gen and confirm a wake happened between two probes.

The `autoResponseConfigured` boolean lets the e2e probe assert config landed (its absence in the diag response = the workerd in use doesn't support it; still safe to deploy).

### 3.5 Verification — auto-response + timeout

The auto-response config is server-set; there's no client-readable handshake header confirming it. Verification path:

1. **Build-time:** new constants exist; constructor try/catch wraps the calls; diag exposes `autoResponseConfigured: true` after a successful invocation; unit test mocks `ctx.setWebSocketAutoResponse` to a spy and asserts it was called once with `'ping'`/`'pong'`.
2. **In-DO test (e2e):** open a WS to `/ws`, send `ping`, expect `pong` back without the supervisor seeing a `webSocketMessage` event (assert via a counter incremented in the handler).
3. **Prod (deferred to deploy):** observability — `/api/_diag/memory` shows `hib.autoResponseConfigured === true`. CF dashboard duration metric drops on idle sessions (validation against the no-auto-response baseline; not part of this wave's deliverable, tracked in CT1).

### 3.6 Files touched

| File | Change |
|---|---|
| `src/process-logs.ts` | Add `PersistAdapter` interface + `setPersist`, `_hydrate`, `_dirty*` markers, flush API. Keep all existing in-memory behaviour byte-identical when no adapter is set (test isolation). |
| `src/process-logs-api.ts` | Switch `server.accept()` → `ctx.acceptWebSocket(server, ['process-logs'])`. Serialize attachment. Accept a new dep param: `ctx`. |
| `src/nimbus-session.ts` | Constructor: try/catch `setWebSocketAutoResponse` + `setHibernatableWebSocketEventTimeout`. Wire `ProcessLogStore` to a `PersistAdapter` impl backed by `ctx.storage.sql`. Add `alarm()` handler (or extend if exists) for flush. Add `webSocketMessage`/`webSocketClose`/`webSocketError` `process-logs` discriminator. Pass `ctx` to `handleLogsWebSocketRequest`. |
| `src/diag-counters.ts` | Add `HibCounters` + getters/setters. Wire into `/api/_diag/memory` response (additive). |
| `src/constants.ts` | Add `NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS = 5_000`. |

## 4. Test plan

### 4.1 Functional probes (`audit/probes/w9/functional/`)

`hib-persist-roundtrip.mjs` — using a Node mock of `ctx.storage.sql` (extend `_mock-sql.mjs` with two-table support), assert:
- append → flush() → drop in-memory state → hydrate → tail returns same chunks
- markExit → flush → drop → hydrate → getExit returns same exit
- 64 KB ring eviction also evicts SQL rows (assert row count drops below threshold)
- `dropOlderThan` cleans both stores symmetrically
- `maxPids` cap evicts oldest exited pid AND its SQL rows

`hib-flush-debounce.mjs` — assert:
- Single append doesn't synchronously flush
- 32 chunks within 250 ms triggers exactly one flush
- 1 s elapse without 32 chunks also triggers a flush
- Flush is a no-op when no dirty chunks

`autoresponse-config.mjs` — using a spy stub for `ctx`:
- Constructor calls `setWebSocketAutoResponse` once with `('ping','pong')`
- Constructor calls `setHibernatableWebSocketEventTimeout(5_000)`
- If both throw, init still succeeds (graceful degrade)
- `diag.hib.autoResponseConfigured` reflects success/failure honestly

### 4.2 Regression probes (`audit/probes/w9/regression/`)

`process-logs-api-shape.mjs` — assert the existing WS protocol contract is unchanged:
- `notfound`, `backlog`, `chunk`, `exit` frames all still emit on the same triggers
- `matchLogsPath` still parses `/api/logs/<pid>` only
- `handleProcessesListRequest` still returns the same object shape
- No new required deps in `LogsWebSocketDeps` that would break callers

`install-pipeline-coverage.mjs` (mirror W5) — re-run the W5 install-pipeline integrity probe to confirm we didn't regress anything in `process-logs.ts` callers (`facet-manager.ts`, `process-table.ts`).

### 4.3 E2E probes (`audit/probes/w9/e2e/`)

`long-running-dev-hib-cycle.mjs` — exercises the full system in `wrangler dev`:
- Spawn a long-running facet that emits stderr lines steadily
- Invoke a forced-hibernation test endpoint (added behind `NIMBUS_DEBUG=1` only — calls `ctx.abort()` analog or just creates a fresh isolate via a new connect)
- Reconnect, fetch `/api/logs/<pid>` backlog
- Assert: last 100 lines intact, exit code present (if exited), `hib.isolateGen` advanced, `hib.rehydratedChunks > 0`, no `webSocketMessage` for ping frames during the idle window

Gate: e2e is `NIMBUS_W9_E2E=1` because it requires `wrangler dev` to be running. Local default suite is functional + regression only — same pattern as W5.

## 5. Anti-requirements / non-goals (this wave)

- Per-chunk write-through to SQL (rejected; write amplification on chatty processes).
- Resurrecting in-memory subscriptions across hibernation (rejected; the client reconnects naturally via a fresh WS open).
- Migrating the W5 ring storage to SQL (orthogonal; W5 chose KV for one logical blob, that's still right).
- Outgoing WS hibernation (Lever C5) — gated on the STOR RFC GA per master roadmap CT2.
- Compat-flag bump (Lever C6) — out of scope, pure config change handled in a separate hygiene PR.

## 6. Acceptance per master roadmap

- Start `npm run dev`, idle 1 hr, server wakes correctly with logs intact ← **functional + e2e**
- WS pings don't wake DO (verified via observability) ← **autoresponse-config probe + diag counter**
- Long-poll/SSE patterns work ← N/A in this wave; preserve current behaviour (process-logs WS is the only WS we touch besides shell/HMR). Long-poll/SSE was a roadmap headline, not a W9 deliverable; will be revisited in W10/W11.
- All W9 tests pass on prod ← deferred per the merged-but-not-deployed Phase 1 pattern.

## 7. Sub-agent / self-review pass

Sub-agent invocation returned `ProviderModelNotFoundError` in this session; review performed inline with explicit grep audits of the affected codebase. Findings:

- **HIGH — close-handler races eviction:** `ctx.storage.sql` writes from inside `webSocketClose` race the actor's eviction. **Mitigation:** wrap in `ctx.waitUntil` (mirrors W5 `_w5SafePersistRing` at `nimbus-session.ts:4039`).
- **HIGH — transactionSync for SQL writes:** SqliteVFS uses `ctx.storage.transactionSync` for atomic schema mutations + multi-row inserts. We must do the same for the alarm-flush path so a partial flush rolls back cleanly. The flush groups one INSERT per dirty pid + one DELETE per evicted pid; all under `transactionSync`. Pure-read paths (hydrate) don't need a transaction.
- **HIGH — `wrangler dev` doesn't actually hibernate the way prod does.** The local DO simulator keeps state across requests. **Mitigation:** define "hibernation simulation" = drop the in-memory `processLogs.pids` Map (and reset `_hydratedPids`) via a test-only endpoint `POST /api/_test/hib/simulate`, then re-issue requests. The next `tail`/`subscribe`/`append` triggers `_hydrate` against the real SQL store. This faithfully exercises the cross-hibernation code path. Endpoint gated on `NIMBUS_DEBUG=1`; 404 otherwise.
- **HIGH — append-then-evict consistency across hibernation:** When in-memory ring evicts a chunk under per-pid byte cap, the corresponding SQL row must NOT be deleted immediately (else recently-hibernated pids' newer-than-cap data is lost on hydrate). **Decision:** SQL retention is bounded by `perPidBytes` (same 64 KB), but pruning runs lazily inside the alarm flush — not on every in-memory evict. Hydrate trims the in-memory side to `perPidBytes` from the newest end. Net behaviour: in-memory ring and SQL ring converge to the same 64 KB after each flush, but transient overshoot in SQL is OK.
- **MED — `setHibernatableWebSocketEventTimeout(5_000)` preempts slow handlers:** the supervisor's message handler delegates to terminal/HMR pipes synchronously and returns; long-running work runs in facets. 5 s is well above observed p99. **Mitigation:** if a regression appears post-deploy, raise to 10 s via the new `NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS` constant (one-line change).
- **MED — alarm dispatcher contention:** confirmed via grep `setAlarm|async alarm` — zero existing handlers. We are the first user. Add a comment block in `nimbus-session.ts` saying "if another subsystem needs alarms, route through a single `alarm()` dispatcher and switch on a `nextAlarmReason` storage key."
- **MED — fork-bomb row explosion:** a 50K-pid spawner would produce ~800K rows ignoring the `maxPids: 500` cap. **Mitigation:** cascade the existing in-memory `_evictOnePid` decision to SQL — when an evicted pid's rows exist, queue a `dropPid(pid)` for the next flush.
- **LOW — SQL schema migrations are perilous in DOs.** **Mitigation:** strictly additive tables (`w9_proc_logs`, `w9_proc_exits`); `CREATE TABLE IF NOT EXISTS`; never alter existing schema. Rollback = drop tables (data is recoverable from terminal scrollback).
- **LOW — test endpoint becomes a prod attack surface.** **Mitigation:** gated on `NIMBUS_DEBUG=1` env var (already used elsewhere); refuses with 404 when disabled.

## 8. Phase plan

| Phase | Output | Commit |
|---|---|---|
| **A** | This file (`W9-plan.md`) | `audit(w9): plan + sub-agent review` |
| **B** | `audit/probes/w9/{functional,regression,e2e}/*.mjs` (all RED initially) | `test(w9): TDD red — hibernation persist + autoresponse + regression` |
| **C** | `src/process-logs.ts`, `src/process-logs-api.ts`, `src/nimbus-session.ts`, `src/diag-counters.ts`, `src/constants.ts` | One commit per layer with test reference |
| **D** | `audit/probes/w9/results-build.txt` (all green) + `tsc --noEmit` clean | `audit(w9): probes green + tsc clean` |
| **E** | `git push origin w9-hib-logs` | — |
| **F** | `audit/sections/W9-retro.md` | `audit(w9): retro — log-loss contract before/after` |
