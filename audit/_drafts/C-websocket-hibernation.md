# Section C — WebSocket Hibernation

> Researched against `wiki.cfdata.org/spaces/STOR` (Primer + RFC) and `developers.cloudflare.com/durable-objects/best-practices/websockets/`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — WebSocket levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **C1** | Switch process-logs WS from `server.accept()` to `ctx.acceptWebSocket()` with `['process-logs']` tag | Process-log tail survives DO hibernation; user reconnect doesn't drop log stream | S |
| **C2** | Add `setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))` for shell + HMR sockets | Cuts DO wake-ups on idle xterm tabs by ~95 %; meaningful billing win | XS |
| **C3** | Set explicit `setHibernatableWebSocketEventTimeout(5_000)` instead of relying on the (undocumented) default | Bounds runaway message handlers to 5 s; prevents one bad shell command from holding the DO for the default (potentially 7-day) window | XS |
| **C4** | Stop nulling `this.shell/terminal/kernel` in `webSocketClose` for the *first* close — wait for explicit `/cleanup` ping | Lets a user reconnect within the hibernation window without losing terminal state | S |
| **C5** | Plan for **outgoing** WS hibernation when the RFC ships — Nimbus's `nimbus-wrangler` and external `npm registry` fetch paths could benefit (the latter doesn't qualify, the former does) | Reduces DO awake-time during long-running outbound pipelines | M (gated on STOR RFC) |
| **C6** | Adopt `compatibility_date >= 2026-04-07` so `web_socket_auto_reply_to_close` is on by default | Drops a class of state-leakage bugs (CLOSING-state WS lingering); already on default at our compat date | XS — confirm only |

C2+C3 are XS wins shippable today. C1 is the highest-impact correctness fix.

---

## C.1 What "Primer" actually says

[STOR/Durable Objects WebSocket Primer: Regular, Hibernatable, and the Outgoing Problem](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem) is the canonical reference. Key facts cross-referenced against Nimbus's code:

### C.1.1 Three tiers (incoming)

| Mode | Native socket lives in | Nimbus uses it for |
|---|---|---|
| **Regular** (`ws.accept()` or `server.accept()`) | `api::WebSocket` (V8 heap). Can't hibernate. | None today, except briefly in `process-logs-api.ts:21-23` |
| **Hibernatable** (`ctx.acceptWebSocket(ws, tags)`) | `HibernationManagerImpl` on `RootCart`. DO can hibernate while WS stays. | Shell terminal and HMR sockets — see [`src/nimbus-session.ts:1160`](../../src/nimbus-session.ts) and [`src/nimbus-session.ts:1465`](../../src/nimbus-session.ts) |
| **Outgoing** (`fetch()` or `new WebSocket()`) | `api::WebSocket` always. Pins the actor via `waitUntil` | Nimbus's nimbus-wrangler facet may use this; npm registry uses HTTP not WS so doesn't count |

### C.1.2 What survives hibernation

> *"**Survives** (in `HibernationManager` / `HibernatableWebSocket` / `HibernationPackage`):*
> - *The `kj::WebSocket` network connection*
> - *URL, protocol, extensions*
> - *Serialized attachment (only if `serializeAttachment()` was called)*
> - *WebSocket tags*
> - *Auto-response configuration*
>
> ***Does not survive** (destroyed with the `Worker::Actor` / `IoContext`):*
> - *All JS in-memory state (DO class instance, closures, variables)*
> - *The `api::WebSocket` objects (only the backing `kj::WebSocket` survives)*
> - *`addEventListener()` listeners (this is why hibernation uses exported handlers)*
> - *`IoOwn`-ed objects*
> - *Non-serialized attachment data*"

### C.1.3 What Nimbus already does right

Nimbus serializes attachments correctly:
- Shell socket: [`nimbus-session.ts:1167`](../../src/nimbus-session.ts) — `serializeAttachment?.({ kind: 'shell' })`
- HMR socket: [`nimbus-session.ts:1467`](../../src/nimbus-session.ts) — `serializeAttachment?.({ kind: 'cirrus-hmr', clientId })`
- Discriminator function: [`nimbus-session.ts:3803-3811`](../../src/nimbus-session.ts) — `_wsKind(ws)` reads back the attachment

This matches the Primer's recommendation. The discriminator is *necessary* because hibernation destroys `addEventListener` and any in-memory `Set<WebSocket>` map; `getWebSockets()` returns sockets without per-instance state, so the only way to re-classify on the next wake is the serialized attachment.

### C.1.4 What's broken

The **process-logs** path uses `server.accept()` (regular WS, non-hibernatable):

```ts
// src/process-logs-api.ts:21-23
// Why server.accept() and not ctx.acceptWebSocket()?
// cleaned up the moment the client closes — no need for hibernation.
```

The reasoning is wrong. Per the Primer:

> *"Hibernatable WebSockets decouple the network connection from the JS runtime. For a DO with thousands of mostly-idle connections, this wastes memory."*

A regular WS pins the DO's `Worker::Actor` for the entire WS duration. If a user opens a long-running tail (`tail -f` of process logs over WS) and walks away from the tab, the DO **cannot hibernate** until the user explicitly closes the tab. Same DO can't hibernate ⇒ accumulating memory ⇒ higher chance of co-residency-OOM under §A.1.

**Lever C1**: switch process-logs to hibernatable.

```ts
// src/process-logs-api.ts (audit-only sketch — do NOT implement)
- server.accept();
+ ctx.acceptWebSocket(server, ['process-logs']);
+ server.serializeAttachment({ kind: 'process-logs', pid });
```

Then add discrimination in `webSocketMessage` / `webSocketClose` for `kind === 'process-logs'`. The receive-side handler reads `pid` from attachment, looks up the process ID in [`src/process-table.ts`](../../src/process-table.ts), and re-attaches log streaming on wake — same shape as the cirrus-hmr handler today.

Net win: a user logged into Nimbus and tailing a long-running build can close their laptop and reopen it 1 hour later. Today: connection torn down or the DO held awake for an hour. After C1: DO hibernates, log-tail WS reopens on wake, log buffer in [`src/process-logs.ts`](../../src/process-logs.ts) is replayed.

---

## C.2 setHibernatableWebSocketEventTimeout

### C.2.1 What the docs say

Per [DurableObjectState API docs (state)](https://developers.cloudflare.com/durable-objects/api/state/#sethibernatablewebsocketeventtimeout):

> *"`setHibernatableWebSocketEventTimeout` sets the maximum amount of time in milliseconds that a WebSocket event can run for. If no parameter or a parameter of `0` is provided and a timeout has been previously set, then the timeout will be unset. The maximum value of timeout is 604,800,000 ms (7 days)."*

The doc doesn't state the **default**. ⚠️ speculation: based on the description and analogy with the [10s `actorMapEvictionTimeoutMs`](https://wiki.cfdata.org/spaces/STOR/pages/1374974291/SPEC+Outbound+connections+should+keep+DOs+alive) (Sandbox eviction timer in `worker-set.c++`), the implicit default is "no timeout" — i.e. a hibernatable WS event handler can run for up to the request CPU cap. Want to confirm by reading workerd source.

### C.2.2 Why Nimbus should set it explicitly

Today Nimbus's [`webSocketMessage` handler at nimbus-session.ts:3777](../../src/nimbus-session.ts) does:

```ts
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
  // Routes to terminal.handleMessage(msg) which can do arbitrary shell work.
}
```

If the user types a command that takes 30s of CPU (a `find / -name '*.js'` on a 10 GB VFS), the DO handles the WS message for 30s — pinning the actor. If the user sends 10 such messages back-to-back, **each one runs in a separate hibernation event**, each potentially up to the request CPU cap.

Setting an explicit timeout bounds this:

```ts
// src/nimbus-session.ts (audit-only sketch)
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
+   // Bound a single hibernation-message handler to 5s. Nimbus's terminal
+   // commands that legitimately take longer (npm install, git clone) run
+   // in facets with their own CPU budget — the WS message handler should
+   // only ENQUEUE work, not perform it.
+   state.setHibernatableWebSocketEventTimeout(5_000);
    // ...
  }
```

5 s is generous for a command-dispatch handler. If a `webSocketMessage` ever takes >5 s, that's a bug — it should be running in a facet. The timeout makes the bug *visible* (workerd will throw) instead of silent.

### C.2.3 Lever C3

Add the constructor call once. Net: bounded resource consumption per WS message. Tiny win, very small effort, hard to argue against.

---

## C.3 Auto-response for ping/pong

### C.3.1 What the docs say

> *"`setWebSocketAutoResponse` sets an automatic response, auto-response, for the request provided for all WebSockets attached to the Durable Object. If a request is received matching the provided request then the auto-response will be returned without waking WebSockets in hibernation and incurring billable duration charges."*
> — [DurableObjectState API docs](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse)

Per the example pattern from [WebSocket Hibernation Server](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/):

```ts
this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
```

### C.3.2 Why Nimbus needs it

xterm.js (Nimbus's terminal client) doesn't ping by default. But:
- Vite HMR clients (the cirrus-hmr socket) *do* ping. Vite's client sends a ping every 30s while idle.
- Browser tabs in background often ping to keep WS alive.

Without auto-response, every ping wakes the DO from hibernation. **Wake = run constructor + handle the message + 10s grace before re-hibernate.** 30s pings × 24h × tabs idle = 2880 wakes/day per idle tab.

Per [PRICE/Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers) (the same model applies to DO requests):

> *"Each fetch() call into the Dynamic Worker [counts as a request]. Each RPC method call on the Dynamic Worker stub [counts as a request]."*

For DOs the same: each wake from hibernation handles a request, billable per request and per CPU-ms.

After C2, a `ping` matched against the auto-response is replied with `pong` **at the runtime layer**, no constructor, no JS execution. **Zero billable wakes**.

### C.3.3 Lever C2 — concrete patch

```ts
// src/nimbus-session.ts (audit-only sketch)
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
+   // Vite HMR clients ping every 30s; xterm idle tabs ping every minute.
+   // Auto-respond at runtime layer to avoid waking the DO. Cuts wake count
+   // by ~95% on idle tabs (per setWebSocketAutoResponse docs).
+   state.setWebSocketAutoResponse(
+     new WebSocketRequestResponsePair('ping', 'pong')
+   );
    // ... existing init ...
  }
```

Caveat: xterm sends terminal data not literally `'ping'`, so the shell socket won't generally match. But Vite HMR's keepalive uses `'ping'`/`'pong'` literally — that path benefits immediately. For the shell socket, xterm's data flow is read-only-from-server in idle state (no client-to-server traffic), so it doesn't matter.

If Nimbus wants stronger ping coverage, the client-side change in `public/xterm.html` to send literal `'ping'` every minute pairs with this — but that's optional.

---

## C.4 Outgoing WebSocket hibernation — RFC status

[STOR/RFC: Outgoing WebSocket Hibernation: Design Options](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options) is **draft**. Quote:

> *"Outgoing WebSocket hibernation is not one feature. It is two:*
> - *Layer A: Outbound websocket hibernation in the sandbox (reuse incoming patterns).*
> - *Layer B: Supervisor liveness preservation without an external caller stub (new mechanism)."*

> *"**Option B is my preferred approach**."* — author (likely [`~harris`](https://wiki.cfdata.org/display/~harris) or the WS team)

What the RFC unblocks for Nimbus, when GA:

### Use cases in Nimbus

1. **`nimbus-wrangler` outbound WS to `wrangler dev`'s preview:** the wrangler dev facet maintains a persistent connection to the parent runtime. Today the supervisor must stay alive. After Outgoing-WS-hib, supervisor can hibernate, the WS continues, message arrival re-creates the supervisor.

2. **External agent connecting to a Nimbus session via outbound WS** (theoretical future): if Nimbus exposes a control plane that opens an outgoing WS to a coordinator, today that prevents the DO from hibernating. RFC would change that.

3. **HMR upstream connections** (theoretical): Vite has no upstream WS today (it's the server) but if Nimbus ever federated multiple Vite instances, this would matter.

Status: **draft RFC, no GA date.** Watch for SHIP status. Author: see the page (RFC was generated by Claude with author edits; the document owner per the parent Primer is the same person).

### Lever C5

Pure planning. When RFC ships, audit Nimbus's outbound WS usage. The most-likely consumer is `nimbus-wrangler` ([`src/nimbus-wrangler.ts`](../../src/nimbus-wrangler.ts)) — confirm its WS pattern.

---

## C.5 The 70-second supervisor eviction

The Primer (Part 2 / "What happens when the caller goes away"):

> *"1. Caller drops its pipeline client. status becomes kj::TimePoint(now).*
> *2. Supervisor eviction timer fires at 70s. cleanupLoop() drops the Pipeline::Client, which destroys RpcActorPipelineImpl, WorkerSet::Actor, and RootCart.*
> *3. The RootCart destruction tears down the Worker::Actor and its IoContext, which destroys the outgoing kj::WebSocket.*
> *4. The external origin sees a disconnect."*

So the 70s number is the supervisor-tier eviction timer. For Nimbus:
- An idle session with no active WS → DO destroyed at 70s after last incoming.
- Reconnect after 71s → cold start (constructor runs). User sees a brief delay.
- All in-memory state lost. `this.shell`, `this.terminal`, `this.kernel` all need to re-init from SQLite VFS.

This is also *what gives Nimbus its multi-tenant cost model* — idle sessions don't bill memory. The trade-off is cold-start latency.

### C.5.1 Lever C4 — tighten the close handler

[`src/nimbus-session.ts:3813-3852`](../../src/nimbus-session.ts) currently nulls `this.shell/terminal/kernel` on every shell-socket close:

```ts
// nimbus-session.ts:3846-3848
this.shell = null;
this.terminal = null;
this.kernel = null;
```

This is **wrong** for the common case of "user navigates away and comes back within 5 seconds." The DO is still in memory (within hibernation grace window), but the close handler nulled the state anyway, forcing a full re-init on reconnect.

Sketch:

```ts
// src/nimbus-session.ts (audit-only sketch)
async webSocketClose(ws: WebSocket, ...) {
  const att = this._wsKind(ws);
  if (att.kind === 'cirrus-hmr') { /* unchanged */ return; }
  // Shell close: don't nuke state. Persist a "last close" timestamp.
- this.shell = null;
- this.terminal = null;
- this.kernel = null;
+ this._lastShellCloseAt = Date.now();
+ // Reap state only if no reconnect arrives within 60s (well under 70s
+ // supervisor evict timer; the reap happens before evict so we don't
+ // race with eviction-induced state loss).
+ this.ctx.storage.setAlarm(this._lastShellCloseAt + 60_000);
}
```

Pair with an `alarm()` handler that nulls state if no reconnect arrived. Best-effort — the DO might evict before the alarm fires, in which case the next reconnect cold-starts (same as today). But the reconnect-within-grace path keeps state. Reduces "I refreshed my browser tab and lost my terminal" friction.

⚠️ note: `setAlarm` might block hibernation. Cross-check with [STOR Primer Part 3 / Event delivery after hibernation](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem) — alarms wake the DO, so this trades hibernation savings for keep-state-warm. Make it a tunable.

---

## C.6 web_socket_auto_reply_to_close — already default

[Compatibility flags docs](https://developers.cloudflare.com/workers/configuration/compatibility-flags/):

> *"### WebSocket auto-reply to close. Default as of 2026-04-07. When a server sends a WebSocket Close frame, the Workers runtime now automatically sends a reciprocal Close frame and transitions readyState to CLOSED before firing the close event. This matches the WebSocket spec and browser behavior."*

Nimbus's [`wrangler.jsonc:5`](../../wrangler.jsonc) sets `compatibility_date: "2026-04-01"`. **That's 6 days before the auto-reply default.** Confirm by checking `compatibility_flags` array — Nimbus's is `["nodejs_compat", "experimental"]`, neither of which is `web_socket_auto_reply_to_close` or its negation.

### Lever C6 — bump compat date or add the flag

Two options:

```jsonc
// wrangler.jsonc — option A: bump compat date
- "compatibility_date": "2026-04-01",
+ "compatibility_date": "2026-04-08",   // or later

// wrangler.jsonc — option B: add the flag explicitly
  "compatibility_flags": ["nodejs_compat", "experimental",
+   "web_socket_auto_reply_to_close"
  ],
```

**Recommend option A** if it doesn't trigger other compatibility-flag default changes between 2026-04-01 and 2026-04-08 (worth checking the full [compatibility-flags page](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) for those 6 days). Otherwise option B is safe.

What this fixes: the existing close handler at [`nimbus-session.ts:3813`](../../src/nimbus-session.ts) won't strand sockets in `CLOSING` state. The Primer says:

> *"Disconnected WebSockets are not returned by [`getWebSockets()`], but `getWebSockets` may still return WebSockets even after `ws.close` has been called. For example, if the server-side WebSocket sends a close, but does not receive one back (and has not detected a disconnect from the client), then the connection is in the CLOSING readyState."*

Without the flag: `getWebSockets()` returns "stale" CLOSING sockets, which can confuse Nimbus's HMR-fanout loop ([`src/cirrus-real.ts`](../../src/cirrus-real.ts) — search `getWebSockets` usage). With the flag: faster transition to `CLOSED`, cleaner fan-out.

---

## C.7 The `disposeAttachment` story

The Primer notes a subtle thing:

> *"`addEventListener()` listeners (this is why hibernation uses exported handlers)"*

Nimbus correctly uses the *exported* `webSocketMessage`, `webSocketClose`, `webSocketError` handlers ([`nimbus-session.ts:3777, 3813, 3854`](../../src/nimbus-session.ts)) — not `addEventListener`. ✓

Also:

> *"Auto-response configuration"* survives hibernation (per the §C.1.2 quote).

That means `setWebSocketAutoResponse` (Lever C2) persists across hibernation cycles. Set once at constructor; works forever. ✓

---

## C.8 Concrete diff, prioritised

### Lever C2 — auto-response (XS, ship today)

Constructor change at [`src/nimbus-session.ts`](../../src/nimbus-session.ts):

```ts
+ state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
```

### Lever C3 — explicit hibernation event timeout (XS)

```ts
+ state.setHibernatableWebSocketEventTimeout(5_000);
```

### Lever C6 — compat date / flag (XS, confirm only)

```jsonc
"compatibility_flags": [..., "web_socket_auto_reply_to_close"],
```

### Lever C1 — process-logs hibernatable (S)

See §C.1.4 sketch.

### Lever C4 — close-handler grace window (S)

See §C.5.1 sketch.

### Lever C5 — outgoing WS hibernation (M, gated)

Plan; no code today.

---

## C.9 Citations summary

Wiki pages:
- STOR/Durable Objects WebSocket Primer: Regular, Hibernatable, and the Outgoing Problem
- STOR/RFC: Outgoing WebSocket Hibernation: Design Options
- STOR/SPEC: Outbound connections should keep DOs alive (70s eviction timer + 10s actorMapEvictionTimeoutMs)
- CSE/Primer: Using and Designing with Durable Objects (acceptWebSocket basics)

Public docs:
- developers.cloudflare.com/durable-objects/best-practices/websockets/
- developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse
- developers.cloudflare.com/durable-objects/api/state/#sethibernatablewebsocketeventtimeout
- developers.cloudflare.com/durable-objects/api/state/#getwebsockets
- developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-auto-reply-to-close
- developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-durable-objects-for-websockets
- developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

Nimbus src/ citations:
- `src/nimbus-session.ts:1160` (shell socket acceptWebSocket)
- `src/nimbus-session.ts:1167` (shell attachment kind)
- `src/nimbus-session.ts:1453-1465` (HMR socket acceptWebSocket — comment about cross-request I/O constraint)
- `src/nimbus-session.ts:1467` (HMR attachment kind+clientId)
- `src/nimbus-session.ts:3777-3794` (webSocketMessage handler with attachment routing)
- `src/nimbus-session.ts:3803-3811` (`_wsKind` discriminator)
- `src/nimbus-session.ts:3813-3852` (webSocketClose — nulls state on every shell close, candidate for Lever C4)
- `src/nimbus-session.ts:3854-3878` (webSocketError — same)
- `src/process-logs-api.ts:21-23` (chose server.accept over hibernatable)
- `src/process-logs.ts:26-27` (in-memory store, no hibernation persistence)
- `src/cirrus-real.ts:680` (HmrBridge / acceptWebSocket via cirrusReal)
- `src/real-vite-hmr.ts:63-92` (HmrBridge forward to facet)
- `wrangler.jsonc:5` (compatibility_date: 2026-04-01)
