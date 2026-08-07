/**
 * cpython-runner.ts — `python` / `python3` / `pip`, on CPython 3.13 built for
 * wasm32-wasi.
 *
 * This replaces the Pyodide runner, and the reason is not the interpreter: it
 * is the filesystem. Pyodide is CPython built with Emscripten, so it brings its
 * own MEMFS, and every invocation had to copy the session's files in and diff
 * them back out through vfs-snapshot.ts. That made Python the last runtime with
 * a private, parallel filesystem. This build talks to runtime/wasi/preamble.ts
 * like clang, bash and ruby do — `open()` in Python is the same syscall as
 * `open()` in C — so there is nothing to copy and nothing to diff.
 *
 * What follows from that:
 *   - manifestVfs, not snapshotVfs: the facet is given sizes and modes and
 *     demand-loads the handful of files the program actually opens.
 *   - supervisorPid, not omitSupervisor: a pool without a supervisor can read
 *     the seeded manifest and can never write anything back. It looks like it
 *     works.
 *   - No Python-level socket shim. CPython's _socket is real here, over
 *     nimbus-net.c and the host's synthetic paths, so loopback is ordinary
 *     socket code rather than a monkey-patch.
 *
 * The interpreter is a WASI reactor (see packages/worker/wasm/python), because
 * a command module's _start runs once and that only covers `python script.py`.
 *
 * One ordering in cpythonRunFacetFn is load-bearing and looks redundant: the
 * supervisor stub is PUBLISHED on globalThis and only then adopted, because
 * __wasiInitFS clears the adoption on purpose and the boot re-adopts it from
 * there afterwards. Adopting once at the entry and deleting the Reflect.set
 * leaves a guest that reads the seeded filesystem and silently writes nowhere —
 * every write queued, none landed, no error anywhere. Ruby carries the same
 * pair for the same reason. The drain in the `finally` is the other half: a
 * program that wrote a file and then raised still wrote the file.
 */
import type { FacetManager } from '../facets/manager.js';
import type { CommandContext } from '../substrate/lifo/commands/types.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { RuntimeManifest } from './runtime-catalog.js';
/**
 * The one canonical facet preamble. Composed in exactly one place: a
 * hand-rolled second copy is how ruby-repl once drifted into booting a VM whose
 * language prelude was missing.
 */
export declare function buildCPythonPreamble(): string;
export declare function makeCPythonRunnerFactory(deps: {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => (ctx: CommandContext) => Promise<number>;
//# sourceMappingURL=cpython-runner.d.ts.map