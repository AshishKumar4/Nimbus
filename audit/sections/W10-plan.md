# W10 Plan — wrangler dev / Cloudflare Workers projects

> **Wave:** W10 — Phase 4 of `MASTER-ROADMAP.md`
> **Branch:** `w10-wrangler-dev`
> **Author session:** nimbus-w10-wrangler-dev (autonomous)
> **Date:** 2026-05-04 (year-long autonomous horizon)
> **Base:** `8b9ac44` (Phase 3 / W7 streams over RPC merged to main)

## 1. The recon-confirmed reality

The roadmap entry (`MASTER-ROADMAP.md:257-273`) lists W10 scope as:

> miniflare/workerd inside facet · Hot reload via VFS file-watch · D1 emulation backed by SqliteVFS · KV emulation backed by SqliteVFS · R2 emulation backed by SqliteVFS or supervisor-RPC-to-real-R2

Three of those five line items are **already in main** (after Phase 2). What actually exists at HEAD:

| Roadmap line item | Status today |
|---|---|
| miniflare/workerd inside facet | **DONE** — `src/nimbus-wrangler.ts` (782 LOC) bundles user code via `EsbuildService` and loads it via `env.LOADER.load()` (workerd-in-workerd via Cloudflare's Worker Loaders binding). Better than miniflare: it IS workerd. |
| Hot reload via VFS file-watch | **DONE** — `nimbus-wrangler.ts:622-647`, debounced 250 ms via `VfsEventEmitter.on()`. Skips `node_modules/`. |
| `vars` / `services` / `assets` / `worker_loaders` / `durable_objects` bindings | **DONE** — Phases 0-3 of `nimbus-wrangler.ts:471-618`. |
| D1 emulation | **TODO** (W10 scope) |
| KV emulation | **TODO** (W10 scope) |
| R2 emulation | **TODO** (W10 scope) |

The unsupported-fields list at `nimbus-session.ts:331-342` is the canonical TODO surface:

```ts
const WRANGLER_UNSUPPORTED_CONFIG_FIELDS = [
  'kv_namespaces',     // ← W10 covers
  'd1_databases',      // ← W10 covers
  'r2_buckets',        // ← W10 covers
  'queues',            // ← out of W10 scope (W10.5 candidate)
  'vectorize', 'ai', 'browser', 'hyperdrive',
  'analytics_engine_datasets', 'dispatch_namespaces',
];
```

W10 removes the first three from that list. The other six are out of scope per the roadmap (only KV/D1/R2 are listed under Acceptance).

Project-type detection: there is no formal abstraction today. The supervisor identifies CF Workers projects ad-hoc by inspecting `wrangler.{jsonc,json,toml}` existence at command-invocation time (`nimbus-session.ts:2068-2078, 3605`). For W10 we extend this to a small `detectCloudflareWorkersProject` helper that the diag/welcome paths can use.

## 2. The four W10 work-items

### 2.1 KV emulation — `src/binding-kv.ts` (NEW)

KV bindings expose this surface to Workers (per [Cloudflare KV API docs](https://developers.cloudflare.com/kv/api/)):

```ts
interface KVNamespace {
  get(key: string, options?: { type?: 'text'|'json'|'arrayBuffer'|'stream'; cacheTtl?: number }): Promise<string|object|ArrayBuffer|ReadableStream|null>;
  getWithMetadata<T = unknown>(key: string, options?: ...): Promise<{ value: ...; metadata: T|null; cacheStatus: string|null }>;
  put(key: string, value: string|ArrayBuffer|ArrayBufferView|ReadableStream, options?: { expiration?: number; expirationTtl?: number; metadata?: any }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string; expiration?: number; metadata?: any }[]; list_complete: boolean; cursor?: string; cacheStatus: string|null }>;
}
```

**Backing store:** SqliteVFS file blobs at `<root>/.nimbus/kv/<binding>/<urlencoded(key)>`. Metadata lives in a sidecar file `<root>/.nimbus/kv/<binding>/<urlencoded(key)>.meta` containing `{ expiration?: number; metadata?: any }` as JSON.

Why VFS-blob and not a SQLite table:
- KV semantics permit eventual consistency and we don't need cross-key transactions.
- File blobs reuse the existing `writeFile`/`readFile` paths (LRU cache, batch writes, OOM-aware).
- `list({prefix})` maps to `vfs.readdir(...)` of the binding directory + filename prefix filter.
- Cleaner inspection: a user can `ls .nimbus/kv/MY_KV/` from the shell and see what's there.

**TTL/expiration:** stored as wall-clock timestamps in the sidecar. Reads return null + lazy-delete on expiry. No background sweeper (acceptable for a dev environment; aligns with miniflare's behavior).

**RPC boundary:** **none.** The KV emulator is constructed inline by `buildInnerEnv()` and runs as a plain JS object on the supervisor side, with the inner Worker calling its methods over the workerd-RPC implicit in `env.<BINDING>`. Workerd serializes the `get/put/list` calls automatically — same as `assets`/`durable_objects` synthesis already does.

### 2.2 D1 emulation — `src/binding-d1.ts` (NEW)

D1 exposes a SQL prepared-statement API:

```ts
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}
interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T>(colName?: string): Promise<T|null>;
  run(): Promise<D1Result>;
  all<T>(): Promise<D1Result<T>>;
  raw<T>(): Promise<T[]>;
}
interface D1Result<T = Record<string, any>> {
  success: boolean;
  results?: T[];
  meta: { duration: number; changes: number; last_row_id: number; rows_read: number; rows_written: number; size_after?: number; served_by?: string };
  error?: string;
}
```

**Backing store:** the supervisor's own `SqlStorage`. We carve out a per-binding namespaced **logical database** by prefixing every CREATE / DML with a binding-scoped table prefix.

**Why supervisor SqlStorage over a child DO facet:** simplicity. A child DO facet via `ctx.facets.get(name, { class: D1Class })` would give us a full 10 GiB SQLite each, but:
- It introduces a new RPC boundary just for D1
- It complicates lifecycle (when do we abort the facet?)
- The supervisor SqlStorage is already 10 GiB and is shared with VFS chunks — not a meaningful capacity loss for dev workloads
- Namespacing via table prefix is a 10-line implementation

The prefix scheme:
- All user tables get prefixed `_d1_<binding>__<table>` at runtime.
- We rewrite SQL using a small parser that walks the SQL string, finds bare-word identifiers in standard slots (`CREATE TABLE x`, `INSERT INTO x`, `UPDATE x SET`, `DELETE FROM x`, `FROM x`, `JOIN x`), and rewrites them.
- Quoted identifiers (`"foo"`, `[foo]`, `` `foo` ``) are also handled.
- Sub-queries use the same rewrite (the parser walks every `FROM`/`JOIN` token regardless of nesting).
- Parameter binding (`?1`, `?`, `:name`) is passed through as-is to `SqlStorage.exec`.

**Why a SQL rewriter over a separate DO:** the alternative is per-binding `ctx.facets.get('d1-' + binding, ...)` for true isolation. We keep that as a fallback if the rewriter proves brittle on real schemas. The rewriter is small + auditable + tested.

**Migrations:** wrangler.jsonc `d1_databases[].migrations_dir` is honored. On `nimbus-wrangler dev`, after binding setup, we look for `<root>/<migrations_dir>/*.sql`, sort by filename, and apply each one inside a transaction once per binding (tracked via a `_d1_<binding>__nimbus_migrations` ledger table). Idempotent.

**TODO out-of-scope:** real D1's read replicas, `d1.session()` API, point-in-time recovery. Local dev doesn't need any of these.

### 2.3 R2 emulation — `src/binding-r2.ts` (NEW)

R2 exposes:

```ts
interface R2Bucket {
  head(key: string): Promise<R2Object|null>;
  get(key: string, options?: { onlyIf?: R2Conditional; range?: R2Range }): Promise<R2ObjectBody|null>;
  put(key: string, value: ReadableStream|ArrayBuffer|ArrayBufferView|string|null|Blob, options?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string,string>; md5?: ArrayBuffer|string; sha1?: ...; sha256?: ...; sha512?: ...; onlyIf?: R2Conditional }): Promise<R2Object|null>;
  delete(keys: string|string[]): Promise<void>;
  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number; include?: ('httpMetadata'|'customMetadata')[] }): Promise<R2Objects>;
  createMultipartUpload(...): Promise<R2MultipartUpload>;  // OUT OF SCOPE
  resumeMultipartUpload(...): Promise<R2MultipartUpload>;  // OUT OF SCOPE
}
```

**Decision: SqliteVFS-backed (NOT supervisor-RPC-to-real-R2).** Reasoning:
- The roadmap allows either; SqliteVFS-backed is offline-capable, deterministic, and doesn't require real R2 credentials in the dev session.
- `supervisor-RPC-to-real-R2` would mean every R2 call traverses the network — high latency for dev iteration.
- A user who wants real R2 can still target prod via `wrangler deploy`.

**Backing store:** identical layout to KV — `<root>/.nimbus/r2/<binding>/<urlencoded(key)>` for the body, `.meta` sidecar for `{httpMetadata, customMetadata, etag, uploaded}`.

**Etag:** SHA-256 hash of the body (mirrors R2's content-addressable etag).

**`R2ObjectBody.body: ReadableStream<Uint8Array>`:** wraps the result of `vfs.readFile(...)` in a `ReadableStream` that enqueues the buffer in one chunk. For a dev environment where blobs are typically <100 MB this is fine. (W7 stream RPC is used internally when the supervisor-side `writeFile` flows large data, but the inner-Worker-facing API is just a stream wrapper around an in-memory Uint8Array.)

**`onlyIf` / etag-based conditionals:** implemented by checking the existing `.meta` etag against the conditional before allowing the operation. `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since` are the four flavours.

**Range reads:** sliced from the in-memory Uint8Array — `body.slice(range.offset, range.offset + range.length)`.

**Out of scope:**
- Multipart upload API (deferred to W10.5 if we see a real Worker need it).
- `R2Bucket.list({delimiter})` returning common-prefixes — implemented but the prefix-tree structure is naive; listing with delimiter on a 10K-key bucket may be slow (acceptable; dev only).

### 2.4 Project type detection — extend `detectCloudflareWorkersProject` in `src/nimbus-session.ts`

A small helper alongside `detectUnsupportedWranglerConfig` that returns `true` when ANY of:

```ts
- vfs.exists(root + '/wrangler.jsonc')
- vfs.exists(root + '/wrangler.json')
- vfs.exists(root + '/wrangler.toml')
- The project's package.json has wrangler in deps or devDeps
```

We DON'T add a global `detectProjectType()` that returns a discriminated union (out of scope; no consumers yet). The single-purpose detector is enough for the welcome / diag / `npm run dev` placeholder paths we need to update.

## 3. Architecture diagram

```
┌───────────────────────────── Outer NimbusSession DO ──────────────────────────────┐
│                                                                                    │
│  Browser                                                                            │
│    │ GET /s/<id>/worker/foo                                                         │
│    ▼                                                                                │
│  fetch() ── routes /worker/* to nimbus-wrangler.handleRequest()  ── (existing)     │
│    │                                                                                │
│    ▼                                                                                │
│  ┌────────────── NimbusWrangler ──────────────┐                                    │
│  │  buildAndLoad():                            │                                    │
│  │    1. esbuild user code                     │                                    │
│  │    2. probe load (extract DO classes)       │                                    │
│  │    3. buildInnerEnv() ← W10 ADDS HERE       │                                    │
│  │    4. LOADER.load({..., env: innerEnv})     │                                    │
│  │  buildInnerEnv():                           │                                    │
│  │    vars            (existing)               │                                    │
│  │    services        (existing)               │                                    │
│  │    assets          (existing)               │                                    │
│  │    worker_loaders  (existing)               │                                    │
│  │    durable_objects (existing)               │                                    │
│  │    kv_namespaces   ← W10 NEW                │                                    │
│  │    d1_databases    ← W10 NEW                │                                    │
│  │    r2_buckets      ← W10 NEW                │                                    │
│  └─────────────────────┬───────────────────────┘                                    │
│                        │ workerd RPC (transparent)                                  │
│                        ▼                                                            │
│  ┌─────────── inner workerd isolate (user's Worker) ──────────┐                    │
│  │   import worker from './main.ts';                            │                    │
│  │   export default {                                           │                    │
│  │     fetch(req, env) {                                        │                    │
│  │       env.MY_KV.get('foo')      ─────┐                       │                    │
│  │       env.DB.prepare('...').run()─┐  │                       │                    │
│  │       env.BUCKET.put('k', body)─┐ │  │                       │                    │
│  │     }                            │ │  │                       │                    │
│  │   }                              │ │  │                       │                    │
│  └──────────────────────────────────┼─┼──┼───────────────────────┘                    │
│                                     │ │  │                                            │
│                                     │ │  │  workerd transparent RPC                   │
│                                     ▼ ▼  ▼                                            │
│  ┌──────────── KvEmulator ┐  ┌─ D1Emulator ─┐  ┌─ R2Emulator ─┐                      │
│  │ get/put/list/delete    │  │ prepare/run/  │  │ get/put/list/ │                      │
│  │ (per binding)          │  │  all/exec/    │  │  delete/head  │                      │
│  │                        │  │  batch        │  │               │                      │
│  └────────┬───────────────┘  └──────┬────────┘  └──────┬────────┘                      │
│           │                         │                  │                              │
│           ▼                         ▼                  ▼                              │
│  SqliteVFSProvider                  ctx.storage.sql    SqliteVFSProvider              │
│    .nimbus/kv/<bind>/                  (table prefix     .nimbus/r2/<bind>/             │
│     <key>                              _d1_<bind>__T)     <key>                        │
│     <key>.meta                                            <key>.meta                   │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## 4. Wrangler config interpretation

The `WranglerConfig` interface at `nimbus-wrangler.ts:29-53` already has the typed fields for all three bindings (lines 34-35). They're declared but not consumed today — Phase 0-3 just ignore them. W10 wires them into `buildInnerEnv()`:

```ts
// nimbus-wrangler.ts (after the durable_objects block, before `return env`)

// ── kv_namespaces ──
if (this.config?.kv_namespaces?.length) {
  for (const kv of this.config.kv_namespaces) {
    if (!kv.binding) continue;
    if (kv.binding in env) this.onLog(`  warning: kv_namespaces binding '${kv.binding}' overwrites a previous key\n`);
    env[kv.binding] = new KvEmulator({
      vfs: this.vfs,
      root: this.root,
      binding: kv.binding,
      onLog: this.onLog,
    });
  }
}

// ── d1_databases ──
if (this.config?.d1_databases?.length) {
  for (const d1 of this.config.d1_databases) {
    if (!d1.binding) continue;
    if (d1.binding in env) this.onLog(`  warning: d1_databases binding '${d1.binding}' overwrites a previous key\n`);
    env[d1.binding] = new D1Emulator({
      sqlStorage: this.supervisorCtx?.storage?.sql,
      binding: d1.binding,
      vfs: this.vfs,
      root: this.root,
      migrationsDir: d1.migrations_dir,
      onLog: this.onLog,
    });
  }
}

// ── r2_buckets ──
if (this.config?.r2_buckets?.length) {
  for (const r2 of this.config.r2_buckets) {
    if (!r2.binding) continue;
    if (r2.binding in env) this.onLog(`  warning: r2_buckets binding '${r2.binding}' overwrites a previous key\n`);
    env[r2.binding] = new R2Emulator({
      vfs: this.vfs,
      root: this.root,
      binding: r2.binding,
      onLog: this.onLog,
    });
  }
}
```

The corresponding `WranglerConfig` extensions:

```ts
interface WranglerConfig {
  // ... existing fields ...
  kv_namespaces?: { binding: string; id?: string; preview_id?: string }[];
  d1_databases?: { binding: string; database_id?: string; database_name?: string; migrations_dir?: string; preview_database_id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string; preview_bucket_name?: string; jurisdiction?: string }[];
}
```

The `id` / `database_id` / `bucket_name` fields are accepted but ignored — the binding name is the only identifier we need locally.

## 5. File-watch hot reload (already done; no W10 changes)

`nimbus-wrangler.ts:622-647` listens to `vfs.events.on()` and rebuilds on changes outside `node_modules/`, debounced 250 ms. Latency target from roadmap: <500 ms file save → reload. Current implementation hits ~300 ms for a small project (debounce + esbuild bundle + LOADER.load reload). W10 doesn't change this; we just verify the latency in the regression test.

**One concern surfaces:** when the user mutates a KV/R2 blob via the inner Worker (calling `env.MY_KV.put(...)` invokes our emulator, which calls `vfs.writeFile(...)`), the VFS event emitter will fire — and our hot-reload watcher will fire a rebuild on every KV/R2 write. The watcher MUST skip `.nimbus/` paths.

Fix: extend the existing `node_modules` skip in `handleVfsEvents` to also skip any path under `.nimbus/`:

```ts
if (event.path.startsWith(this.root) &&
    !event.path.includes('node_modules/') &&
    !event.path.includes('/.nimbus/')) {
  needsRebuild = true;
}
```

This is a 1-line change and lives next to the existing `node_modules` filter.

## 6. Hot reload latency target

From the roadmap acceptance: "Hot reload latency <500ms on file save."

Decomposition:
- VFS event emit: <1 ms (in-memory event bus)
- Debounce: 250 ms (intentional — coalesces rapid saves; not subtractable)
- esbuild bundle: typically 50-150 ms for a single-file Worker (esbuild-wasm)
- LOADER.load call: 30-80 ms (measured during W7-era observation)

So budget under realistic conditions: **~330-480 ms** for a tiny worker. Larger workers (pulling in lodash etc.) may overshoot 500 ms; the 250 ms debounce can drop to 100 ms if needed (we'd add a `--debounce` flag) but defer that to W10.5 if measurement shows a real regression.

Measurement: a regression probe `audit/probes/w10/regression/hot-reload-latency.mjs` that uses the mock-vfs harness + a tiny Worker, mutates the entry file, observes the rebuild promise, asserts <500 ms.

## 7. Detection contract

### 7.1 `detectCloudflareWorkersProject(vfs, root)`

Returns `boolean`. True if any of:
- `<root>/wrangler.jsonc` exists
- `<root>/wrangler.json` exists
- `<root>/wrangler.toml` exists
- `<root>/package.json` parses to `{ devDependencies: { wrangler: ... } }` OR `{ dependencies: { wrangler: ... } }`

Used by:
- (future) framework-detection in W11 for "is this CF Workers, not just any Node project?"
- The diag endpoint to surface project-type for support
- The welcome / new-session greeting (e.g. "I see this is a CF Workers project — try `wrangler dev`")

We're NOT going to wire it into `npm run dev` interception this session — that'd be a behavior change orthogonal to bindings.

### 7.2 Wiring point

Add to `nimbus-session.ts` near `detectUnsupportedWranglerConfig` (line ~352). Export it as a top-level function (the existing detector isn't exported; we keep symmetry). Wire one consumer: `/api/_diag` should include `cloudflareWorkersProject: boolean` in its response.

## 8. Probes (TDD red phase plan)

Layout follows W8/W9 conventions:

```
audit/probes/w10/
├── _tap.mjs                       # lifted from w8/_tap.mjs
├── _mock-vfs.mjs                  # in-memory SqliteVFS shim (read/write/list/exists, events)
├── _mock-sql.mjs                  # in-memory SqlStorage shim (lifted from w9; D1 needs this)
├── _shim-loaderenv.mjs            # mock loaderEnv with LOADER.load echo
├── functional/
│   ├── kv-put-get.mjs              # text/json/arrayBuffer types
│   ├── kv-list-prefix.mjs          # prefix + cursor pagination
│   ├── kv-delete.mjs
│   ├── kv-ttl-expiration.mjs       # expirationTtl + lazy delete
│   ├── kv-metadata-roundtrip.mjs   # putWithMetadata + getWithMetadata
│   ├── d1-prepare-bind-run.mjs     # CREATE TABLE + INSERT + SELECT
│   ├── d1-prepare-all.mjs          # multi-row results + meta
│   ├── d1-prepare-first.mjs        # first(colName) projection
│   ├── d1-batch.mjs                # batch() multi-statement
│   ├── d1-exec.mjs                 # exec(query) bulk
│   ├── d1-table-prefix-isolation.mjs # two D1 bindings don't see each other's tables
│   ├── d1-migrations.mjs           # migrations_dir replay + idempotency ledger
│   ├── r2-put-get.mjs              # roundtrip with body types
│   ├── r2-head.mjs                 # head() returns metadata, not body
│   ├── r2-list-prefix.mjs
│   ├── r2-delete-single-and-array.mjs
│   ├── r2-conditionals.mjs         # If-Match / If-None-Match
│   ├── r2-range-read.mjs
│   ├── r2-etag-content-addressed.mjs # etag = sha256(body)
│   ├── env-bindings-injection.mjs  # buildInnerEnv synthesizes all 3 binding types
│   └── project-type-detection.mjs  # detectCloudflareWorkersProject (4 inputs)
├── regression/
│   ├── install-pipeline-coverage.mjs   # check that npm install path still works (lifted from w8)
│   ├── nimbus-wrangler-existing-bindings-still-work.mjs  # vars/services/assets/worker_loaders/DOs unchanged
│   ├── hot-reload-latency.mjs          # <500ms target verified
│   └── nimbus-paths-not-watched.mjs    # .nimbus/ writes don't trigger rebuild
├── e2e/
│   ├── starter-worker-router.mjs       # clone CF starter, wrangler dev, GET / → 200 expected HTML
│   ├── starter-d1.mjs                  # clone D1 starter, schema-init succeeds
│   ├── kv-roundtrip-e2e.mjs            # full inner-Worker → KV → response cycle
│   └── unsupported-fields-list-shrinks.mjs # kv/d1/r2 no longer in WRANGLER_UNSUPPORTED_CONFIG_FIELDS
└── run-all.mjs
```

E2E "real `wrangler dev`" tests use `_test-interpreter.mjs`-style mocks (lifted from w8) — they construct an in-memory `loaderEnv.LOADER.load()` that echoes back a stub Worker with the synthesized `env`, and assert the bindings answer correctly. This is NOT a real workerd run inside the test (impossible at unit-test time without a deployed DO) but it DOES exercise:
- `NimbusWrangler.start()` end-to-end
- esbuild bundling (real, via the test-side esbuild)
- `buildInnerEnv()` synthesis
- The proxy/handleRequest flow

The "real-prod" e2e (acceptance gate per roadmap) has to run against a deployed Nimbus — it's gated behind `NIMBUS_W10_E2E_PROD=1` and lives in `e2e/starter-worker-router.mjs`. Local CI runs the unit-shim version of that probe.

### 8.1 Probe acceptance for Phase B (red)

Every probe must be committed and **fail** before any src/ change lands. The standard W3-W9 TDD pattern.

After Phase C, ALL probes must pass (the local-runnable ones — the prod-gated `e2e/starter-*.mjs` SKIP locally as designed).

## 9. Not in scope for W10 (W10.5 candidates)

- **Queues** (producer + consumer)
- **Vectorize / AI / Browser / Hyperdrive / Analytics Engine / Dispatch namespaces** — explicitly out per `WRANGLER_UNSUPPORTED_CONFIG_FIELDS` (roadmap defers these)
- **D1 read replicas / `.session()` API** — prod-only feature, not testable locally
- **R2 multipart uploads** — defer to W10.5 if we see real Worker need
- **`KVNamespace.list({prefix: undefined})` performance on 10K+ keys** — naive readdir scan; OK for dev
- **Real-wrangler `--remote` mode** — orthogonal; users can deploy with real wrangler if they need real bindings
- **Migration to `FacetManager.spawn()` for PID/process-table integration** — out of scope; nimbus-wrangler still uses direct `LOADER.load()` like today

## 10. Files touched

| File | Change | LOC est. |
|---|---|---|
| `src/binding-kv.ts` | NEW — `KvEmulator` class | ~280 |
| `src/binding-d1.ts` | NEW — `D1Emulator` + SQL rewriter | ~420 |
| `src/binding-r2.ts` | NEW — `R2Emulator` class + R2Object/R2ObjectBody helpers | ~380 |
| `src/nimbus-wrangler.ts` | EDIT — extend `WranglerConfig`, three new blocks in `buildInnerEnv()`, `.nimbus/` skip in `handleVfsEvents` | +60 |
| `src/nimbus-session.ts` | EDIT — remove `kv_namespaces`/`d1_databases`/`r2_buckets` from `WRANGLER_UNSUPPORTED_CONFIG_FIELDS`, add `detectCloudflareWorkersProject` helper, wire it into `/api/_diag` | +30 |
| `audit/probes/w10/**` | NEW — 21 functional, 4 regression, 4 e2e probes + harness | ~2,800 |
| `audit/sections/W10-plan.md` | NEW — this file | (this) |
| `audit/sections/W10-retro.md` | NEW (Phase F) | TBD |
| `audit/sessions/W10-progress.md` | NEW | TBD |

Total src LOC: ~1,170 new + ~90 edits. Probe LOC: ~2,800.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **D1 SQL rewriter is a regex monster** | Keep grammar-aware: actually iterate tokens (not regexes). Have explicit unit tests for the 8 SQL forms (CREATE/INSERT/SELECT/UPDATE/DELETE/JOIN/subquery/quoted-ident). If we hit a failure on real schemas, fallback path is per-binding ctx.facets.get(). |
| **VFS event storm from `.nimbus/` writes** | Skip `.nimbus/` paths in `handleVfsEvents`. Tested in `regression/nimbus-paths-not-watched.mjs`. |
| **KV/R2 list on huge namespaces** | Out of scope for W10 — dev workloads only. Document in retro. |
| **D1 type coercion mismatches** | Mirror SqlStorage's coercion (it already mostly matches D1's). Test integer/text/blob/null roundtrip. |
| **Inner Worker holds an env reference across rebuilds** | The rebuild creates a fresh inner Worker via `LOADER.load()` — old env GCs naturally. Same pattern as durable_objects today. |
| **R2 `body: ReadableStream` consumed twice by user code** | R2's real semantics: stream is one-shot. We match: re-`get()` to get a fresh stream. Tested. |
| **Concurrent puts to same key race** | Use the VFS `writeBatch` for atomic body+meta pair where it matters. KV/R2 within a single binding are not transactional in real CF either. |

## 12. Sub-agent review hook

Before committing the plan, the autonomous reviewer subagent reads this file and the recon findings, looks for:
1. **Architectural soundness** — does the buildInnerEnv extension match the existing pattern?
2. **Completeness** — are there CF API surface methods missing from the contract?
3. **Risk coverage** — any obvious gotcha not in §11?
4. **Test coverage** — does §8 exercise every claim in §2?

The review's notes get appended below as §13.

## 13. Review notes (serial inline review — sub-agent provider unavailable)

> Sub-agent reviewer was unavailable this session (`ProviderModelNotFoundError`).
> Per task directives, falling back to serial inline review with an explicit
> review-comment commit. Reviewer hat: senior workerd / Workers-runtime engineer.

### A. Strengths
- Reuse over rewrite: extending `buildInnerEnv()` is the surgical path. Three new blocks parallel the existing five (vars/services/assets/worker_loaders/durable_objects). No new RPC boundaries.
- VFS-backed for KV/R2 lets users inspect data via the shell (`ls .nimbus/kv/MY_KV/`) — much better DX than miniflare's opaque blob store.
- The `.nimbus/`-paths-not-watched fix prevents an obvious feedback loop. Caught early.

### B. Major concerns

**B1. workerd RPC compatibility of plain JS objects on `env`. Severity: HIGH.**

The plan asserts: *"the inner Worker calling its methods over the workerd-RPC implicit in `env.<BINDING>`. Workerd serializes the get/put/list calls automatically — same as `assets`/`durable_objects` synthesis already does."*

This is **partially correct but misleading**. The existing `assets`/`worker_loaders`/`durable_objects` synthesis at `nimbus-wrangler.ts:538, 571, 603` use `ctx.exports.NimbusAssetsRPC({props: {...}})` etc. — those are **WorkerEntrypoint** instances obtained from named loopback bindings, NOT plain JS objects. workerd's RPC channel transparently shuttles JsRpcTarget-marked classes (WorkerEntrypoint, DurableObject, RpcTarget). A bare JS object literal `{get: async (k) => ...}` is **NOT** automatically a JsRpcTarget across the LOADER.load env boundary — it would need to either:

1. Live as a WorkerEntrypoint loopback (e.g. `class NimbusKvRPC extends WorkerEntrypoint`, registered in index.ts, instantiated via `ctx.exports.NimbusKvRPC({props: {binding, root}})`), OR
2. Live as an `RpcTarget` subclass instance attached directly to env (workerd does support this; bare RpcTarget instances are valid env values).

Option (2) is simpler and aligns with the existing `LOADER.load({env: innerEnv})` plumbing. The supervisor's loaderEnv binding lives in the same workerd instance, so cross-isolate RPC marshaling occurs but RpcTarget handles that natively.

**Suggested fix:** make `KvEmulator`, `D1Emulator`, `R2Emulator` extend `RpcTarget` (`import { RpcTarget } from "cloudflare:workers"`). Each public API method becomes an instance method; workerd's RPC layer intercepts calls. This is the lowest-friction shape and matches the workers-runtime contract.

Verify by skimming workerd's [RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/) §"Properties on env": *"You can pass any JsRpcTarget-derived class instance as a binding."*

This needs to be reflected in the build-phase implementation. Documented impact:
- Each emulator extends `RpcTarget`.
- `R2ObjectBody` (which itself is the return value of `R2Emulator.get()`) needs to also be an RpcTarget subclass (or just a plain object — return values from RPC methods are structured-cloned, which IS allowed for plain objects with primitive fields + `body: ReadableStream`). The latter works.

**B2. KV API — `getWithMetadata` and the `cacheStatus` field. Severity: MEDIUM.**

Per CF docs, `KVNamespace.get()` returns `Promise<value>` directly; `getWithMetadata()` returns `Promise<{value, metadata, cacheStatus}>`. The plan's contract is correct in §2.1. But the plan elides:

- KV `cacheTtl` option — we should accept and ignore (documented).
- `cacheStatus` — always `null` is fine for emulator (no real edge cache).
- `bulk` operations: KV doesn't have `getMany` in the runtime API (REST API only). Skip.
- `metadata` size limit (1024 B in real KV). We don't enforce; document in retro.

**Suggested fix:** add a probe `kv-cachettl-accepted-ignored.mjs` and document in retro that metadata size is unenforced.

**B3. D1 SQL rewriter is brittle for CTEs / window functions / triggers / views. Severity: MEDIUM.**

The plan's §2.2 describes "a small parser that walks the SQL string, finds bare-word identifiers in standard slots." This handles simple DML but:
- **CTEs** (`WITH x AS (SELECT ...) SELECT * FROM x`) — `x` is an alias inside the CTE that references the user's table inside parens; rewriter must rewrite the inner FROM but NOT the CTE alias name itself.
- **Triggers, Views, Indexes** — `CREATE TRIGGER`, `CREATE VIEW`, `CREATE INDEX` reference table names too.
- **Pragma** — `PRAGMA table_info(x)` references table names.
- **Window functions** — fine, no name rewrites needed inside `OVER (...)`.

A proper SQL parser (sqlite-parser, etc.) is overkill — but the plan's "small parser" risks under-handling. **Suggested fix:** instead of trying to rewrite via tokenization, use **per-binding attached database** approach:
- Bind a uniquely-named SQLite attached database per D1 binding using `ATTACH DATABASE ...` semantics.
- BUT: workerd's SqlStorage doesn't expose ATTACH (it's a single-database API).

So fallback: keep the rewriter, but recognize this is the riskiest piece. Plan to either:
1. **Keep rewriter narrow:** SUPPORT only what the test fixtures cover (CREATE TABLE, INSERT, UPDATE, DELETE, SELECT with JOIN/subquery). Document CTEs / TRIGGERS / PRAGMA as "may not work; falls through" in retro.
2. **Better alternative:** allocate one **child DO facet per D1 binding** via `ctx.facets.get('d1-' + binding, {class: D1FacetClass, ...})`. The facet has its own SqlStorage at full 10 GiB; no namespacing needed; the user's SQL flows through unchanged. Trade: one DO facet per binding lifetime, but DO facets are cheap (per W6 Facet manager already mints them for execStream).

Strong recommendation: **switch to the child-facet approach for D1**. Reasons:
- Eliminates the rewriter entirely (zero false positives / negatives).
- Matches the architectural shape `_execViaFacets` already uses (proven pattern).
- Storage isolation is cleaner — no risk of D1 binding A reading D1 binding B's tables via crafted SQL.
- Cost: ~250 LOC for `D1Facet` (DO class with one fetch handler) + facet wiring; rewriter saves ~400 LOC. Net wash, much better correctness.

**Updating §2.2:** flip backing strategy to child DO facet per binding. The `D1Emulator` (RpcTarget on the supervisor side) just forwards prepared-statement calls to the facet via RPC. The facet runs SqlStorage natively.

This is the single biggest change to the plan from the review — explicitly tracking it as an amendment in §15.

**B4. R2 multipart upload — explicit user pain. Severity: LOW (acceptable trade) but document.**

Out of scope is correct (multipart is non-trivial: 10 GiB+ uploads, 5+ MiB part minimums, 3-day retention of incomplete uploads). But popular Workers — image optimization pipelines, log shippers — DO use multipart for large blobs. Ensure the unsupported case throws a clear error: `R2Emulator.createMultipartUpload()` should throw `Error('R2 multipart uploads not supported in nimbus-wrangler dev (W10.5 candidate)')` rather than silently undefined.

### C. Minor nits

- §2.1: KV `expirationTtl` is in seconds, `expiration` is a Unix timestamp in seconds. Document that the sidecar stores Unix seconds.
- §2.3: R2 `etag` is a hex SHA-256, but real R2's etag is MD5 for non-multipart objects (32 hex chars). For dev parity prefer SHA-256-truncated-to-32-hex (informational only; user code rarely compares etags byte-for-byte against real R2).
- §6: clamp the debounce to 100 ms via env var `NIMBUS_W10_DEBOUNCE_MS` for users who run a fast machine and want sub-300 ms cycles. Cheap to add.
- §7.1: include `wrangler.toml` even though our parser is minimal — detection ≠ full support.
- §8: add a probe that exercises `Object.keys(env)` from inside a synthesized inner env to confirm bindings are enumerable (workerd requirement for some user code patterns).

### D. Verdict

**APPROVE WITH FIXES.** Major fixes:
- (B1) Make emulators extend `RpcTarget`.
- (B3) Switch D1 backing from "supervisor SqlStorage with table-prefix rewriter" to "child DO facet per binding" — much safer.
- (B4) `createMultipartUpload` throws-with-message rather than undefined.
- Other items (B2, C1-5) are in-scope nice-to-haves; track in implementation.

Plan is otherwise sound. Proceed to Phase B (TDD red) with the §15 amendments applied.

## 14. Pre-implementation amendments (post-review)

### 14.1 D1 backing: child DO facet per binding (was: supervisor SqlStorage with rewriter)

New file `src/d1-facet.ts` exports a `D1Facet` Durable Object class. The supervisor:

```ts
// src/binding-d1.ts (new — RpcTarget on supervisor side)
export class D1Emulator extends RpcTarget {
  constructor(private opts: {
    facetStub: any;       // ctx.facets.get('d1-<binding>', { class: D1Facet, ... }).getEntrypoint()
    binding: string;
    onLog: (m: string) => void;
  }) { super(); }

  prepare(query: string): D1PreparedStatement { return new D1PreparedStatementEmu(this.opts.facetStub, query, []); }
  async batch(stmts) { return this.opts.facetStub.batch(stmts.map(s => ({sql: s._sql, params: s._params}))); }
  async exec(query) { return this.opts.facetStub.exec(query); }
}
```

The D1Facet class lives in `src/d1-facet.ts` and is registered as a Durable Object in `wrangler.jsonc`'s `migrations` (so the SqlStorage backing it is available; the supervisor mints it via `ctx.facets.get` exactly like `_execViaFacets`). Each facet has its own SqlStorage at full 10 GiB.

This eliminates the SQL rewriter entirely. Drop `src/binding-d1.ts`'s rewriter from the file budget; instead `src/d1-facet.ts` (~280 LOC) replaces it.

### 14.2 RpcTarget extension

`KvEmulator`, `D1Emulator`, `R2Emulator`, `D1PreparedStatementEmu` all `extend RpcTarget`. This is a single import + class declaration change; mention it explicitly in build commits.

### 14.3 New file budget

| File | Was | Now |
|---|---|---|
| `src/binding-kv.ts` | ~280 | ~290 (RpcTarget) |
| `src/binding-d1.ts` | ~420 | ~180 (no rewriter) |
| `src/d1-facet.ts` | — | NEW ~280 |
| `src/binding-r2.ts` | ~380 | ~390 (RpcTarget) |
| `src/nimbus-wrangler.ts` | +60 | +60 |
| `src/nimbus-session.ts` | +30 | +50 (DO class registration for D1Facet) |
| `wrangler.jsonc` (in Nimbus's own deploy config) | — | +10 (durable_object_namespace + migrations entry for D1Facet) |

Total src LOC: ~1,140 + ~110 edits. Probe LOC unchanged.

### 14.4 Probe additions

- `functional/kv-cachettl-accepted-ignored.mjs`
- `functional/env-keys-enumerable.mjs` — `Object.keys(env)` returns binding names
- `functional/d1-cte-and-trigger.mjs` — exercises CTE and TRIGGER (would have failed under rewriter, passes via child-facet)
- `functional/r2-multipart-throws.mjs` — explicit-error contract

These move the probe count from 21+4+4=29 to 25+4+4=33 (functional bumps).

### 14.5 Hot reload latency optional knob

Read `NIMBUS_W10_DEBOUNCE_MS` env var in `NimbusWrangler.handleVfsEvents`; default 250.

