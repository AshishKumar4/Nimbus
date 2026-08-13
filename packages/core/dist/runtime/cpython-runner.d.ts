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
 * FOUR THINGS THIS RUNTIME REDISCOVERED THE HARD WAY, ALL OF WHICH ruby-runner
 * ALREADY KNEW. Read the list rather than finding a fifth:
 *   1. Every entry into the VM goes through WebAssembly.promising, not only the
 *      calls known to park — a Suspending import traps on an unpromised stack
 *      even when it returns a plain integer.
 *   2. The supervisor is adopted AFTER __wasiInitFS, which clears it on purpose,
 *      and the facet drains queued writes in a `finally`.
 *   3. modes are seeded `{ '': 7, tmp: 7, home: 7 }` ahead of the manifest,
 *      because manifestVfs's walk skips the empty root — without it the preopen
 *      at '/' is mode 0 and every traversal under it is EACCES.
 *   4. The loader pool is built per invocation, never cached: supervisorPid is
 *      baked into the SUPERVISOR binding at construction, so a held pool hands
 *      every later caller the first caller's write credential.
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
import type { Command } from '../substrate/lifo/commands/types.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetHost } from './facet-host.js';
import type { RuntimeManifest } from './runtime-manifest.js';
/**
 * The one canonical facet preamble. Composed in exactly one place: a
 * hand-rolled second copy is how ruby-repl once drifted into booting a VM whose
 * language prelude was missing.
 */
export declare function buildCPythonPreamble(): string;
export interface CPythonFacetResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}
/**
 * Start a program that outlives the invocation, and report where it went.
 *
 * A separate dependency rather than a branch, because a resident process is a
 * property of the DEPLOYMENT and not of Python: it needs a substrate that can
 * keep an actor alive between requests and route inbound HTTP into it. A host
 * that has none does not get a degraded version — it gets none, and says so.
 */
export type CPythonResidentStart = (spawn: {
    /** VFS path of the interpreter. By path, not by value: it is 10.6 MiB. */
    wasmVfsPath: string;
    startArgs: Record<string, unknown>;
    cwd: string;
    command: string;
}) => Promise<CPythonFacetResult>;
export declare function makeCPythonRunnerFactory(deps: {
    facets: FacetHost;
    vfs: SqliteVFS;
    /** Where a program that keeps serving goes. See {@link CPythonResidentStart}. */
    startResident?: CPythonResidentStart;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
//# sourceMappingURL=cpython-runner.d.ts.map