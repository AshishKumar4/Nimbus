# prod-reset-investigation — progress

Branch: `prod-reset-investigation`
Charter: audit-first investigation of Bug C (DO RESET mid-session) on prod
`https://nimbus.ashishkmr472.workers.dev/` (script version `27dce349`).

Bug A (output-ordering race) + Bug B (W5 supervisor-heap log reads zero) are
explicitly out of scope this round; both have prior-pass evidence in
`audit/probes/prod-reset-investigation/repro-faint-mango-5526.stdout` from the
crashed first attempt and will be picked up in follow-up dispatches.

## Phase A1 — STARTING 2026-05-08T05:19:12Z

This file is the "I'm alive" signal per the reduced charter. Subsequent phases
will append below.

Worktree: `/workspace/worktrees/prod-reset-investigation` (re-used from the
previous crashed attempt — `bun install` already ran, `node_modules/.bin/wrangler`
is present, branch is `prod-reset-investigation` tracking `origin/main` at
`0a022e6`).

Recovered evidence from the crashed first attempt (still present in
`audit/probes/prod-reset-investigation/`):

- `tail-LIVE.jsonl` — 1.3 KiB of wrangler-tail JSON from prod (only
  request-completion frames, no exceptions, no log lines because the
  driving WS session never crashed within capture window).
- `repro.ts` + `repro-faint-mango-5526.stdout` — the user repro DID complete
  cleanly (`isolateGen` stayed at 1, banner printed once, vite ran). 70-second
  hold did not reproduce Bug C — strong signal that the failure mode requires
  a longer / heavier session than the one-shot repro.
- `repro-long.ts` — a 6-minute interactive-liveness probe that was launched
  in the background just before the previous-run crash. Will be re-launched
  in Phase A2.
- `diag-trace-faint-mango-5526.jsonl` — ~25 samples from `/api/_diag/memory`
  during the repro. `isolateGen` stable at 1; `installPhase`/`resolverPhase`
  both `idle` post-install; `lastFailures: 0`. No OOM-ring evidence in this
  trace, so H1 (OOM kill) is provisionally weakened (but a 70 s window is
  too short to draw the conclusion firmly).

Phase A1 committed and pushed below.

## Phase A2 — completed 2026-05-08T05:21Z

### A2.1 — wrangler tail captured 281 frames during 14 minutes of repro

`audit/probes/prod-reset-investigation/tail-LIVE.jsonl` (≈ 376 KB, 281 distinct
request-completion frames). Wrangler tail launched in the previous run is
still active (pid 529434). The capture spans both the short repro
(`faint-mango-5526`) and the 6-minute long repro (`snowy-peak-3541`).

**Key tail aggregates:**

| Metric | Value | Interpretation |
|---|---|---|
| total frames | 281 | |
| `outcome=ok` | 241 | normal completions |
| `outcome=canceled` | 40 | **all** are `SupervisorRPC` (dynamic-Worker isolates), max wallTime 2.7 s — consistent with normal facet teardown |
| exceptions | 0 | no uncaught throws on `27dce349` during repro window |
| error/warn logs | 0 | no `console.error` / `console.warn` either |
| script versions seen | only `27dce349-…` | **single deployment** during capture; no rolling restart from a deploy |
| max `NimbusSession` wallTime | **106 747 ms (106 s)** | one DO request held open for 106 s — see §A2.3 |

### A2.2 — repro-long (6 min, 12 probes) reproduced no Bug C

`audit/probes/prod-reset-investigation/repro-long-snowy-peak-3541.stderr` —
the 6-minute interactive-liveness probe ran `cd app && npm i`, `npm run dev`
(vite), then sent `\r` every 30 s for 12 probes. **All 12 probes had RTT
~200 ms (stable, no lag).** Banner count = 1 (no DO reset). WS closed
cleanly with code 1000.

This reproduces the user's **steady-state** — but NOT the failure mode. Two
possibilities to test in subsequent phases:

1. The user opened the **preview iframe** (`/s/<id>/preview/`) which spins
   up the HMR WS, additional Worker-Loader-spawned facets, and the assets
   binding chain — none of which my headless WS-only repro exercises.
2. The user kept multiple browser tabs open (preview + terminal + maybe
   `/api/_diag/memory` debug tab), driving more parallel DO traffic than
   one WS produces.

### A2.3 — `/api/_diag/memory` wallTime is bimodal & suspicious

`audit/probes/prod-reset-investigation/wallTime-histogram.txt`:

```
{
  "<100":     12,
  "100-500":  23,
  "500-1000": 10,
  "1-5s":     15,
  "~5s":      22,    ← 22 frames clustered at ~5 085 ms (within 200 ms of 5 000)
  "5-15s":    1,
  "15-60s":   12,
  ">60s":     4      ← max 106 747 ms — six 5-s timeouts back-to-back?
}
```

The `~5 s` cluster matches the `NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS = 5 000`
constant (`src/ws-hibernation-config.ts:38`). Hypothesis: when the DO is
in a hibernatable state with the shell WS attached, **inbound HTTP requests
(`fetch()`) are queued behind the DO input lock and the `setHibernatable
WebSocketEventTimeout(5000)` cap forces a 5-s minimum tail on each fetch
that overlaps with a queued hibernation-eligible event**.

The 106-second outlier is roughly 21 × 5 s. Suggests a request that re-
queued behind successive 5-s gates ≥20 times. The `_diag/memory` endpoint
is supposed to be cheap; the only observable DO-blocking work it does is
`ensureSqliteFs()` + `_diagSampleMemory()` + a few VFS stat reads, all of
which are microseconds.

### A2.4 — recovered diag-trace shows isolateGen stable at 1

`audit/probes/prod-reset-investigation/diag-trace-faint-mango-5526.jsonl`
is 25 samples taken every 5 s during the 70-s repro. `isolateGen` stayed
at 1 the whole time — the DO did NOT restart during my repro. Same
result for the 6-minute long repro (banner count = 1).

So the user's reproduction has SOMETHING my headless probe doesn't. Most
likely candidate: the browser preview iframe, which fires HMR WS + many
asset fetches concurrently with the terminal WS.

---

## Track A build dispatch — STARTING 2026-05-08T05:31:42Z

Per `audit/sections/PROD-RESET-INVESTIGATION-plan.md §3.1`. Two changes,
both confined to `src/nimbus-session-init.ts`:

1. **A.1** — persist shell cwd across re-init so PWD doesn't drift to `~`
2. **A.2** — suppress MOTD on silent re-init within the same isolate

Budget: ≤ 80 LoC. TDD: 4 probes (3 functional/regression + 1 e2e). Audit
gate: probes GREEN + cross-wave 0 regressions + `tsc --noEmit` baseline
preserved.

---

## Course correction — 2026-05-08T05:48:00Z

User explicitly rejected Track A as scoped:

> "I dont want any hacky or patchy fixes ever. I want solid architectural
> improvements that guarantee things would work even under memory pressure."

Verdict on Track A as written in the original §3:

- **A.1 (cwd persist via Object.defineProperty on shell.cwd)** — symptom-
  hiding patch. Monkey-patches a third-party class field with a
  property accessor; the trigger that nuked the shell in the first
  place is unaddressed. User would still observe: lag → reset →
  prompt now lies (cwd appears preserved but kernel/processes/
  facetMgr could be in any state).
- **A.2 (MOTD-suppress flag)** — pure cosmetic. Hides the visible
  signal that the session was reset, which makes the underlying
  instability HARDER to detect, not easier.

Both are exactly what the user said they don't want. Neither addresses
the trigger (heap pressure → OOM-equivalent state) nor makes the
recovery PATH itself correct. They paper over symptoms.

### What lands here

1. **G1** — this acknowledgement (I'm alive, course corrected).
2. **G2** — `git revert` of the one Track A src/ commit (`2b304de`).
   TDD probes from F2 (`45e05d5`) stay — they're evidence of the bug's
   user-visible mechanism, useful for verifying the architectural
   tracks below.
3. **G3** — replace plan §3 with three architectural tracks (A'/B'/C')
   that target the trigger, the recovery correctness, and the
   observability prerequisite respectively.
4. **G4** — dispatch order in plan §4.
5. **G5** — retro update.

NO new src/ commits this dispatch. Plan-mode only after this point.

---

## Research wave starting — 2026-05-08T06:03:09Z

Per the user's research-first directive: NO src/ edits this dispatch.
Plan §3 + §4 must be re-grounded in actual platform internals before
any of the 5 review gates are confirmed.

Tooling available in this session:
- `CF_Docs_search_cloudflare_documentation` — Cloudflare public
  documentation search. Cited as `[CF Docs / <query>]` below.
- Public docs URLs via `webfetch`. Cited as `[<URL>]`.

Tooling NOT available in this session:
- `wiki-mcp-server_*` — internal Cloudflare wiki MCP. Not exposed in
  the OpenCode tool list for this session.
- `gitlab-mcp-server_*` — internal Cloudflare GitLab MCP. Not exposed.

Implication: R1-R6 will rely on **public CF docs** (the canonical
authoritative public source for platform behaviour) supplemented by
**workerd source code** (open-source reference for the runtime — same
binary that ships on edge for the Workers/DO runtime, modulo fleet-
specific patches). Where the user's prompt asked for a wiki-only
artefact (e.g. SHIP numbers), this dispatch will mark `⚠ UNVERIFIED:
internal-only — pending wiki access`. The findings still settle with
high confidence on the architecturally relevant questions because the
public docs + workerd source + observed prod behaviour cover the
load-bearing claims for plan §3.

Phases R1-R6 each produce one `audit/sections/PROD-RESET-RESEARCH-
R<n>.md`. R7 synthesises. R8 + R9 fold the findings back into
plan §3 and §4.4 gates. Each phase commits+pushes before the next
starts (commit-after-every-step per the X.5-U pattern).

Citation discipline: `✓ CONFIRMED` (public docs / workerd source
agree with current code), `❗ ARCHITECTURE-IMPACTING` (public docs
/ workerd source contradict an architectural assumption in the
current code or in plan §3 as written), `⚠ UNVERIFIED` (interesting
but not yet sourced — to be resolved before any build dispatch).
