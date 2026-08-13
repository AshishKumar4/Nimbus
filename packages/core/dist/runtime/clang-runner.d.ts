/**
 * clang-runner.ts — compile, link, and execute C programs for Nimbus WASI.
 *
 * Architecture (compile-link-run, two facet calls):
 *
 *   compile  : clang.wasm + sysroot subset for C includes + user .c
 *              → produces .o bytes (returned to supervisor).
 *   link     : lld.wasm + sysroot subset for link (crt1.o + libc.a)
 *              + .o from compile → produces .wasm executable.
 *   write    : final .wasm flushed to user VFS at the requested path.
 *
 * The filesystem both halves see is the one WASI layer every other
 * non-node runtime uses (wasi-instance.ts), seeded and sealed.
 *
 * Splitting compile and link into separate facet calls keeps each
 * call under the empirical payload ceiling. Each ships:
 *
 *   - compile: 31 MiB clang.wasm + ~1.3 MiB sysroot subset (C includes).
 *   - link   : 19 MiB lld.wasm + ~0.75 MiB libs + tiny .o.
 *
 * Sysroot subset extraction happens supervisor-side via a small ustar
 * parser. The full sysroot.tar is parsed once when the clang runtime
 * warms for a session; compile/link calls reuse the filtered subsets.
 *
 * Dispatch stays direct: no sleeps, no caller-side retries, and no
 * catch-and-continue around loader failures.
 */
import type { RuntimeManifest } from './runtime-manifest.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { FacetHost } from './facet-host.js';
/** Build the runner factory. Closes over the facet host + vfs. */
export declare function makeClangRunnerFactory(deps: {
    facets: FacetHost;
    vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export declare const CLANG_RUNNER_PREAMBLE: string;
//# sourceMappingURL=clang-runner.d.ts.map