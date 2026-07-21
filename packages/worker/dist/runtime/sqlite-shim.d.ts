/**
 * sqlite-shim.ts — node:sqlite shim for Nimbus facets, backed by sql.js
 * (Emscripten SQLite wasm) running in-memory inside the facet isolate.
 *
 * Like streams.ts / node-shims.ts, this emits a raw JS string embedded in
 * the generated facet module. The emitted block:
 *
 *   1. Boots the sql.js engine LAZILY AND SYNCHRONOUSLY on the first
 *      DatabaseSync open (`__getSQL`): it calls the prepared glue factory
 *      with a synchronous `instantiateWasm` hook fed the pre-compiled
 *      WebAssembly.Module from `globalThis.__nimbusSqliteWasmModule`
 *      (attached by the facet module map) and captures the ready Module
 *      synchronously (sql.js uses the caller's config object AS the
 *      Emscripten Module and runs postRun in the same tick when
 *      instantiation is synchronous). The ready namespace is stashed on
 *      `globalThis.__nimbusSQL`. Laziness matters: the engine boot costs
 *      ~48 MiB of facet memory (measured live 2026-07-21, #35), which a
 *      process that never opens a DB — e.g. the opencode attach TUI
 *      client — must not pay inside a memory-capped facet. A caller that
 *      certainly WILL open a DB (the opencode serve facet) boots eagerly
 *      via `globalThis.__nimbusInitSqlite()` to keep its proven boot shape.
 *
 *   2. Defines `__sqliteMod` = { DatabaseSync, ... } registered as
 *      builtins.sqlite + builtins["node:sqlite"].
 *
 * Persistence model: a file-backed DatabaseSync loads its bytes
 * synchronously from `__vfsBundle` (the facet's startup snapshot of the
 * live SQLite VFS, which includes the working tree) on open, and flushes
 * `db.export()` back to the live VFS via the async supervisor bridge
 * (`__supervisor.writeFile`) on close and at explicit checkpoints. This
 * matches the existing sync-fs durability contract: whole-DB snapshot,
 * single in-memory connection, no page-level disk IO, no cross-process
 * WAL.
 *
 * Scope (opencode's method matrix): DatabaseSync(path|:memory:, options)
 * with .prepare/.exec/.close/.loadExtension(throws); StatementSync with
 * .all/.run/.get/.setReadBigInts/.setReturnArrays. Anything else throws a
 * clear "node:sqlite: <method> not supported" — never faked.
 *
 * Runtime scope dependencies (in scope where SHIMS is interpolated):
 *   - __vfsBundle:  Record<string, string | Uint8Array>  (snapshot reads)
 *   - __supervisor: { writeFile(path, bytes): Promise } | null  (flush)
 *   - __pendingIO:  Promise[]  (so flushes are drained before teardown)
 */
/**
 * Module-init preamble that prepares the sql.js `initSqlJs` factory.
 *
 * workerd disallows code-generation-from-strings (`new Function`, `eval`)
 * at REQUEST time inside dynamic-worker isolates, but ALLOWS it during
 * module evaluation / startup. The sql.js glue can only be turned into a
 * callable via `new Function`, so this runs at the facet's top level —
 * prepended (alongside the static `import "sqlite.wasm"`) by the facet
 * code generators ONLY when the bundle imports node:sqlite.
 *
 * It evaluates the glue with a globalThis Proxy that masks the environment
 * sentinels sql.js sniffs — `process` (ENVIRONMENT_IS_NODE; avoids
 * require("node:fs")/process.argv), `WorkerGlobalScope` and `document`
 * (ENVIRONMENT_IS_WORKER/WEB; avoids `self.location.href`, which is
 * undefined in workerd dynamic-worker isolates and would throw). With all
 * three masked, sql.js takes the bare path: no fetch/fs wasm loading (we
 * supply instantiateWasm), crypto.getRandomValues for RNG. The resulting
 * factory is parked on globalThis.__nimbusSqlJsFactory; the request-time
 * boot (generateSqliteShimCode) calls it with an instantiateWasm hook.
 */
export declare function generateSqliteFacetPreamble(): string;
export declare function generateSqliteShimCode(): string;
//# sourceMappingURL=sqlite-shim.d.ts.map