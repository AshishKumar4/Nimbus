/**
 * sqlite-shim.ts — node:sqlite shim for Nimbus facets, backed by sql.js
 * (Emscripten SQLite wasm) running in-memory inside the facet isolate.
 *
 * Like node-shims.ts, this emits a raw JS string embedded in
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
 *      builtins.sqlite, which only node:sqlite names (node-shims.ts __nimbusBuiltinId).
 *
 * Persistence model: a file-backed DatabaseSync is the process's file, the
 * one its name denoted when it opened, read and written through the
 * process's own filesystem (`__fsMod`). Open loads the file's bytes with
 * readFileSync (a missing file is a new database); close exports the image
 * and writes it back with writeFileSync unless its bytes are the ones
 * loaded. So the next open in the same run sees what the close wrote, and
 * the session gets it in program order, as any other write. Whole-DB image,
 * single in-memory connection: a connection's changes reach the file only on
 * close, and two connections to one file each write their own image.
 *
 * Scope (opencode's method matrix): DatabaseSync(path|:memory:, options)
 * with .prepare/.exec/.close/.loadExtension(throws); StatementSync with
 * .all/.run/.get/.setReadBigInts/.setReturnArrays. Anything else throws a
 * clear "node:sqlite: <method> not supported" — never faked.
 *
 * Runtime scope dependencies (in scope where SHIMS is interpolated):
 *   - __fsMod: the process's node:fs (readFileSync, writeFileSync)
 *   - __pathMod: the process's node:path (resolve, against its cwd)
 *   - __cryptoMod: node:crypto (createHash), to know a WAL image unchanged
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