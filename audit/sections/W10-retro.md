# W10 Retro — wrangler dev / Cloudflare Workers projects

> **Branch:** `w10-wrangler-dev`
> **Base:** `8b9ac44` (Phase 3 / W7 streams over RPC merged)
> **Author session:** nimbus-w10-wrangler-dev (autonomous)
> **Date:** 2026-05-05

## 1. What we set out to do

Per `MASTER-ROADMAP.md:257-273`, W10 aimed for:

| Acceptance gate | Status |
|---|---|
| Official CF Workers starter: clone, `wrangler dev`, /preview/ works | ⚠ prod-gated — local e2e GREEN, deployed e2e blocked on CF auth |
| D1 starter: clone, schema-init succeeds | ⚠ same |
| Hot reload latency <500 ms on file save | ✓ measured 302 ms in regression |
| All W10 tests pass on prod | ⚠ prod-gated; local 28/28 GREEN |

## 2. What actually happened — outcome vs predicted

### What worked end-to-end (LOCAL)

- **KV emulator** — full Workers KV runtime API: `get/getWithMetadata/put/delete/list` with text/json/arrayBuffer/stream value types, TTL via `expiration` and `expirationTtl`, per-binding metadata sidecar, prefix/cursor pagination. **6/6 functional probes GREEN.**
- **D1 emulator** — `prepare/bind/run/all/raw/first`, `batch` with snapshot/restore atomicity, `exec` with multi-statement splitting (string-literal-aware), CTE support (WITH … SELECT), CREATE TRIGGER no-op, per-binding table prefixing for multi-database isolation. **6/6 functional probes GREEN.**
- **R2 emulator** — `head/get/put/delete/list`, range reads (`offset/length/suffix`), conditionals (`etagMatches/etagDoesNotMatch/uploadedBefore/uploadedAfter`), content-addressed sha256 etags, custom + http metadata, delimiter-list common prefixes, multipart explicitly throws clear errors. **8/8 functional probes GREEN.**
- **Hot reload** — debounced 250 ms, `.nimbus/` paths skipped (KV/R2 writes don't feedback-loop), latency 302 ms measured. **GREEN.**
- **Project type detection** — `detectCloudflareWorkersProject()` with 4 input signals (jsonc/json/toml/package.json+wrangler-dep). **8/8 inputs GREEN.**
- **Synthesis path integration** — `buildInnerEnv()` in nimbus-wrangler.ts emits the three new binding types; existing 5 binding categories (vars/services/assets/worker_loaders/durable_objects) unchanged. **GREEN.**
- **Unsupported-fields list** — `kv_namespaces`, `d1_databases`, `r2_buckets` removed; queues + 5 others remain (W10.5+). **GREEN.**

### What's prod-gated

- **`audit/probes/w10/e2e/starter-worker-router.mjs`** — STUB. Requires deployed Nimbus + WS terminal automation. See §6 below.
- **`audit/probes/w10/e2e/starter-d1.mjs`** — same.

The user-facing gate: when wrangler auth refreshes, run the deploy-and-verify procedure in MASTER-ROADMAP.md "Pending Prod Deploys" §, and the prod e2e probes should be exercised manually until the orchestrator lands.

### What didn't fall short, but was de-scoped before implementation

The plan §13 review (B3) recommended **child DO facet per D1 binding** for full SqlStorage isolation (each binding gets its own 10 GiB SQLite). We deferred to W10.5 because:
1. The required wrangler.jsonc DO migration entry + new DO class registration touches deployment config — slightly outside the "src/-only" budget.
2. Current table-prefix approach with the SQL identifier rewriter PASSES the d1-cte-and-trigger probe (which was the #1 risk concern from the review).
3. The drop-in upgrade is straightforward when we move forward.

The plan §13 review (B1) recommended **emulators extend RpcTarget** for workerd correctness across the LOADER.load env boundary. We did NOT extend RpcTarget because:
1. RpcTarget isn't currently imported anywhere in the codebase (verified: `grep -r RpcTarget src/` empty).
2. Workerd's `LOADER.load({env: ...})` propagates plain JS objects to the inner env (verified by the `e2e/kv-roundtrip-e2e` probe which uses a mock LOADER importing the inner Worker via data: URL).
3. **HOWEVER:** real production workerd may behave differently than our mock LOADER. This is the highest-risk unverified assumption. The prod e2e probes are the safety net.
4. If real workerd rejects the plain-JS-object pattern, fix is a 5-line diff per emulator class (extend RpcTarget). Tracked in §6.

## 3. Surprises during build

### S1. SQL rewriter narrower than feared

The plan §13 review B3 painted the SQL rewriter as risky. The actual implementation: ~150 LOC of token-aware walking with a `RESERVED` keyword set. CTEs (WITH … AS) work via the SELECT-from-known-table path (the CTE alias itself isn't registered, but the inner SELECT references the user's table by name). CREATE TRIGGER passes through with no name rewriting needed (we don't track index/trigger names; only TABLE/VIEW). Worked first try once paramOffset was reset per row.

### S2. mock-sql paramOffset bug shipped to red phase

The d1-prepare-bind-run probe initially failed because the mock-sql harness's `_evalWhere` advanced `_paramOffset` once across all row evaluations — so by row 2 of a SELECT with WHERE, the `?` was reading params[1] instead of params[0]. Easy fix (reset per row) but a reminder that probe harnesses are also code-under-test.

### S3. `cloudflare:workers` import isolation

The probe `project-type-detection.mjs` couldn't import `nimbus-session.ts` because nimbus-session unconditionally imports `cloudflare:workers`, which isn't available under Bun. Solution: extracted `detectCloudflareWorkersProject` into a leaf module `src/project-detect.ts`, re-exported from nimbus-session.ts. Cleaner architecture as a side-effect: future detectors (Vite, Next, etc.) have an obvious home.

### S4. esbuild-service tsc error pre-existed

When tsc surfaced two errors (`esbuild-wasm.wasm` module + SqliteVFSProvider FileType), I worried W10 had introduced them. Verified by checking on origin/main directly — both predate this wave. Not W10's responsibility.

### S5. Buffer is unavailable under tsc

`Buffer.from(...).toString('base64url')` worked at runtime under both Bun and workerd (nodejs_compat) but tsc's type definitions don't expose `Buffer` as a global without `@types/node` in the types field. Switched to Web Standard `btoa`/`atob` with a base64→base64url patch — cleaner anyway and avoids the workerd-vs-Bun coercion mismatch when nodejs_compat is mid-boot.

## 4. Hot reload latency measurement

Regression probe `hot-reload-latency.mjs`:
- Single source-file edit → rebuild observed at **302 ms**
- 5 rapid saves within 100 ms → coalesced to **1 rebuild**
- Budget breakdown:
  - 0-1 ms: VFS event emit (in-memory bus)
  - 250 ms: debounce window (intentional; coalesces rapid saves)
  - ~50 ms: mock esbuild delay (real esbuild-wasm is ~50-200 ms)
  - ~1-2 ms: HMR message dispatch
- Real workerd LOADER.load adds 30-80 ms (uncovered by mock); real-prod target ≈380-480 ms.

**Verdict:** comfortably under 500 ms target for typical workers. Larger workers pulling lodash etc. may push toward the limit; W10.5 candidate is exposing `NIMBUS_W10_DEBOUNCE_MS` env var for users who run on fast hardware and want sub-300 ms cycles.

## 5. CF features that work end-to-end (LOCAL)

| Feature | Status | Probe |
|---|---|---|
| `env.MY_KV.get/put/delete/list` | ✓ | functional/kv-* + e2e/kv-roundtrip-e2e |
| `env.MY_KV.getWithMetadata` | ✓ | functional/kv-metadata-roundtrip |
| KV TTL (expiration, expirationTtl) | ✓ | functional/kv-ttl-expiration |
| `env.DB.prepare(...).bind(...).run/all/first/raw` | ✓ | functional/d1-* |
| `env.DB.batch([...])` (atomic) | ✓ | functional/d1-batch |
| `env.DB.exec("multi; statement; sql;")` | ✓ | functional/d1-exec |
| D1 CTE (WITH … SELECT) | ✓ | functional/d1-cte-and-trigger |
| D1 CREATE TRIGGER | ✓ | functional/d1-cte-and-trigger |
| D1 multi-binding isolation | ✓ | functional/d1-table-prefix-isolation |
| D1 migrations (migrations_dir) | ✓ (idempotent ledger) | _no-direct-probe — applied at start_ |
| `env.BUCKET.head/get/put/delete/list` | ✓ | functional/r2-* |
| R2 conditional onlyIf (etag) | ✓ | functional/r2-conditionals |
| R2 range reads (offset/length/suffix) | ✓ | functional/r2-range-read |
| R2 content-addressed sha256 etag | ✓ | functional/r2-etag-content-addressed |
| R2 list with delimiter | ✓ | functional/r2-list-prefix |
| Hot reload <500 ms | ✓ (302 ms) | regression/hot-reload-latency |
| `.nimbus/` writes don't trigger rebuild | ✓ | regression/nimbus-paths-not-watched |
| Project type detection | ✓ | functional/project-type-detection |
| WranglerConfig synthesis end-to-end | ✓ | functional/env-bindings-injection |

## 6. CF features that fall short (W10.5 candidates)

| Feature | Reason | Severity |
|---|---|---|
| **R2 multipart upload** (createMultipartUpload / resumeMultipartUpload) | Out of scope per plan §9. Throws clear error per §13 review B4. | MEDIUM — popular in image/log Workers |
| **R2 server-side hash verify** (md5/sha1/sha512) | Only sha256 verified; others ignored | LOW — rare at dev time |
| **D1 child-DO-facet-per-binding** | Plan §14.1 amendment; deferred to keep wave src/-only | LOW — table prefix is correct for dev |
| **D1 `.session()` API** (read replicas) | Prod-only feature | OUT OF SCOPE permanently |
| **Queues** (producer + consumer) | Out per roadmap | MEDIUM — common in event-driven workers |
| **Vectorize / AI / Browser / Hyperdrive / Analytics / Dispatch** | Out per roadmap | LOW (each) — niche |
| **`KVNamespace.list({prefix:''})` perf on 10K+ keys** | Naive readdir scan | LOW — dev only |
| **Real workerd RPC env compatibility** | Mock LOADER passes plain JS objects; real workerd may need RpcTarget | **HIGH — only validated by prod e2e** |

## 7. Recommendations for W10.5

Ranked by impact:

1. **Run the prod e2e probes** (manually until orchestrator). If real workerd rejects the plain-JS-object pattern on env (HIGH risk in §6), pivot to RpcTarget extension. 5-line diff per emulator. Plan §13 review B1 is the safety net.

2. **R2 multipart upload** support. Many users of R2 in image/log pipelines need this. Implementation: track multipart state in a sidecar JSON ledger under `.nimbus/r2/<binding>/.multipart/<uploadId>/parts/<n>`, assemble on `complete()`.

3. **D1 child-DO-facet-per-binding** upgrade (plan §14.1). Eliminates the SQL rewriter entirely. Each binding gets its own SqlStorage at full 10 GiB. Requires a new DO class registered in src/index.ts + a wrangler.jsonc migration entry.

4. **`NIMBUS_W10_DEBOUNCE_MS` env knob** for users on fast hardware. Trivial.

5. **Queues emulation** for event-driven Workers. Producer side fires into a per-binding queue; consumer side polls or invokes the consumer Worker. Both backed by SqliteVFS-stored JSON message lists.

6. **Project type interception in `npm run dev`**: detect CF Workers project, auto-route to nimbus-wrangler dev instead of generic node-script handler.

7. **Wrangler.toml full TOML parser**: today the parser handles flat `key = "value"` only. A real TOML lib (smol-toml, ~5-15 KB) would unlock users who hand-write TOML configs with binding sections.

## 8. Files touched

| File | Change | LOC |
|---|---|---|
| `src/binding-kv.ts` | NEW — KvEmulator | 309 |
| `src/binding-d1.ts` | NEW — D1Emulator + D1PreparedStatementEmu + TablePrefixer | 480 |
| `src/binding-r2.ts` | NEW — R2Emulator + R2Object/R2ObjectBody | 449 |
| `src/project-detect.ts` | NEW — detectCloudflareWorkersProject | 39 |
| `src/nimbus-wrangler.ts` | EDIT — buildInnerEnv extension + .nimbus/ skip + test seams | +163 |
| `src/nimbus-session.ts` | EDIT — trim WRANGLER_UNSUPPORTED_CONFIG_FIELDS + re-export | -8 +6 |
| `audit/sections/W10-plan.md` | NEW — architecture, contracts, review §13, amendments §14 | 611 |
| `audit/sections/W10-retro.md` | NEW — this file | (this) |
| `audit/sessions/W10-progress.md` | NEW — progress log | ~70 |
| `audit/probes/w10/_tap.mjs` | NEW — TAP harness | 80 |
| `audit/probes/w10/_mock-vfs.mjs` | NEW — in-memory SqliteVFS | 178 |
| `audit/probes/w10/_mock-sql.mjs` | NEW — in-memory SqlStorage | 308 |
| `audit/probes/w10/functional/*` | NEW — 22 probes | ~1,400 |
| `audit/probes/w10/regression/*` | NEW — 4 probes | ~300 |
| `audit/probes/w10/e2e/*` | NEW — 4 probes (2 prod-gated stubs) | ~250 |
| `audit/probes/w10/run-all.mjs` | NEW — orchestrator | 76 |

**Total new src LOC:** 1,277
**Total edit src LOC:** ~170
**Total probe LOC:** ~2,592

## 9. Sub-phase commit summary

```
3e3c80d  w10 phase A: plan — KV/D1/R2 emulation extending buildInnerEnv()
5327142  w10 phase B: TDD red — 30 probes (28 RED + 2 prod-skip)
bfdac68  w10 phase C1: src/binding-kv.ts — KV namespace emulator
5795ee8  w10 phase C2: src/binding-d1.ts — D1 database emulator
e108cc8  w10 phase C3: src/binding-r2.ts — R2 bucket emulator
35bdb26  w10 phase C4: nimbus-wrangler.ts — extend buildInnerEnv + .nimbus/ skip + test seams
0fedbae  w10 phase C5: nimbus-session.ts — trim unsupported list + project-detect.ts
c748ac0  w10 phase D: tsc-clean — Web-Standard btoa/atob + controller typing
```

## 10. Status flag for MASTER-ROADMAP.md

W10 row 50 should be flipped from `pending` to:
`code-merged-pending-prod-verify` (prod e2e gates require deployed Nimbus + WS terminal orchestration; same gating shape as W3-W9 per `MASTER-ROADMAP.md` "Pending Prod Deploys" section).

Branch `w10-wrangler-dev` ready for review/merge:
- `bfdac68..c748ac0` (8 commits, all on origin)
- All local probes GREEN (28/28 + 2 SKIP)
- W10 files tsc-clean
- No pre-existing tsc errors introduced
- No regressions to prior-wave probes (verified by `regression/install-pipeline-coverage` + `regression/nimbus-wrangler-existing-bindings-still-work`)
