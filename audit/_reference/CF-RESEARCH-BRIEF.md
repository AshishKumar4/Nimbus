# CF Internal Optimization Research — Brief for nimbus-cf-internal-research session

## Goal
Deep research using Cloudflare INTERNAL wiki/docs/GitLab to produce a comprehensive plan to make Nimbus much better, more efficient, more robust. Use cloudflare-docs MCP, wiki-mcp MCP, gitlab-mcp MCP. Sub-agents in parallel.

## Quality bar
`audit/_reference/MOSSAIC-LATENCY-EXAMPLE.md` (527 LOC) — read FIRST. Every claim cited (wiki URL OR src/ file:line). Latency tables. Code-diff patches. TL;DR with effort. THIS is the bar.

## Deliverable
`audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` — 1500-3500 LOC. TL;DR ranked levers + per-area sections (A-J).

## Head-start wiki refs (all verified to exist)
- STOR/Mini-PRD: DO shared isolate issues
- STOR/SPEC: Address SQLITE_NOMEM issues
- STOR/Durable Objects WebSocket Primer: Regular, Hibernatable, Outgoing
- STOR/RFC: Outgoing WebSocket Hibernation
- ~pkhanna/Dynamic worker sharding
- ~birvine-broque/[RFC] Dynamic Workers Observability
- ~ketan/Abuse Detection Dynamic Workers
- ~dkozlov/Powering Dispatcher with Worker Loader
- PRICE/Dynamic Workers
- EW/Workers Limits
- ~yagiz/Impact of polyfills to workers
- VID/Scaling Stream Live's DO calls
- EW/SPEC: Python Workers Package Bundling System

Adjacent searches required: durable object alarm, smart placement, cache API workerd, workers queues, container workers cloudchamber, hyperdrive, workers pipelines, RPC bandwidth, structured-clone limit, WebSocket message size, DO observability, capnproto perf, edgeworker.

Each adjacent page found: classify directly-relevant / adjacent / orthogonal. Cite only relevant ones.

## Required sections (every one populated; if no findings, mark "skipped — no actionable")

### A. DO isolate / memory model
- 128MB shared-isolate reality vs guarantee, Dice termination timing
- Dedicated-isolate namespace flag — production status? what's gating GA?
- SQLITE_NOMEM SPEC: when 128 MiB pool cap hits Nimbus's SqliteVFS, what's the user-visible failure?
- Memory pressure notification API — proposed but landed?
- Per-DO memory accounting roadmap

### B. Dynamic Workers / Worker Loader / Facets
- LOADER.get() byte budget — verify our empirical 22 MiB encoded cap is doc-aligned
- Per-request concurrent dynamic worker limit (we hit ~5-6 empirically — what's the doc number?)
- Per-metal active dynamic worker limit
- Facet billing vs parent DO
- worker_loaders[].observability config — what comes for free?
- Dice abuse detection — does our npm-install pattern (high request rate, lots of code load) trigger it?

### C. WebSocket hibernation
- Verify our state serialization vs DO WebSocket Primer best practice
- setHibernatableWebSocketEventTimeout — should we tune it?
- Outgoing WebSocket hibernation — status, impact on user code with outbound WS
- Auto-response config for ping-pong — could reduce wakeups

### D. npm install architecture
- Compare to Python Workers Package Bundling SPEC pattern
- R2-backed npm cache feasibility — quantify registry hit rate, latency saving
- Cross-region: where does npm registry serve from when called from a workerd metal?

### E. RPC layer + structured-clone wall
- Workerd source-of-truth for 32 MiB RPC cap (cite sqlite.c++ or kj/capnp)
- writeBatch chunking pattern — better alternatives?
- ctx.exports loopback (SUPERVISOR) perf characteristics
- modules-map vs R2-backed-fetch-inside-facet tradeoffs

### F. Observability
- What /api/_diag/memory should ALSO surface
- Tail Workers applicable to dynamic workers? (RFC says yes — verify)
- Workers Logpush + Analytics Engine for npm install telemetry
- OpenTelemetry in DOs (Waiting Room mentions WR-1069)

### G. Cost / billing
- 128 MiB-increment billing for short facets — implication
- Batch-facet coalescing verification (we already coalesce resolver+install)
- Smart Placement for supervisor DO
- DO read replicas (now GA) applicability for read-mostly Nimbus paths

### H. Roadmap / future-ahead
- CF in-flight items affecting Nimbus: script-size hike, dedicated-isolate flag GA, memory pressure API, container workers GA, multi-region DO
- Which team to partner with for each (Slack/email/wiki-page-author)

### I. CF projects similar to Nimbus
- Browser Rendering API patterns
- AI Sandbox / agent code execution
- Workers-for-Platforms (same constraints, different use case)
- Any internal "vibe coding" / app builder
- EW-XXXX tickets that would unblock Nimbus (cite specific Jira IDs)

### J. Concrete code changes (Mossaic-doc style)
For each lever in TL;DR table: exact diff snippet with src/ file:line. Code blocks like:
```ts
// src/foo.ts:123
- old.code()
+ new.code()
```

## Methodology
1. Read MOSSAIC example doc end-to-end
2. Read MEMORY.md, ARCHITECTURE.md, IMPROVEMENTS.md, audit/UNIVERSAL-NODE-COMPAT.md to ground
3. Sub-agents in parallel — each researches ONE area (A-J)
4. Each sub-agent writes draft to audit/_drafts/<letter>-<topic>.md
5. Synthesize into CF-INTERNAL-OPTIMIZATION-RESEARCH.md with unified TL;DR
6. Sub-agent reviews synthesis before final commit

## Anti-requirements
- NO src/ edits. NO src/ commits.
- audit/ writes only.
- Every claim cited (wiki URL, doc URL, src/ file:line, or "⚠️ speculation")
- No filler. Empty area = "no actionable findings — skipped".

## Done criteria
- audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md exists, 10 areas populated
- ≥50 wiki/doc citations
- ≥15 src/ file:line citations
- TL;DR ≥10 ranked levers
- audit/_drafts/ exists with per-area drafts (provenance)
- Single commit + push: `audit: CF-internal optimization research`

~2-3 hours. Quality > speed. PAUSE and ASK if blocker hit. Do NOT silently complete.
