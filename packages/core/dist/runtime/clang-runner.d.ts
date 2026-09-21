/**
 * clang-runner.ts — compile, link, and execute C programs for Nimbus WASI.
 *
 * Architecture (compile-link, two facet calls):
 *
 *   compile  : clang.wasm over the session filesystem → writes each
 *              translation unit's .o under a scratch directory in /tmp.
 *   link     : wasm-ld.wasm over the same filesystem → writes the final
 *              .wasm executable at the requested output path.
 *
 * The filesystem both halves see is the session authority, reached through
 * the same supervisor capability every other non-node runtime uses
 * (wasi-instance.ts): the facet is opened with the caller's pid, so a
 * source the caller cannot read stays unreadable and an output directory
 * the caller cannot write stays unwritten. Nothing is copied in or out.
 *
 * The sysroot (headers, crt1.o, libc.a, compiler-rt) ships as one ustar
 * archive in the installed runtime, `share/clang/sysroot.tar`, and is
 * unpacked ONCE per session into `share/clang/sysroot/` beside it — a
 * world-readable tree the toolchain is pointed at by absolute path. A missing or damaged archive is reported and the command exits;
 * there is no header set to fall back on.
 *
 * Splitting compile and link into separate facet calls keeps each wasm
 * image its own facet: 31 MiB clang.wasm, 19 MiB wasm-ld.wasm.
 *
 * Dispatch stays direct: no sleeps, no caller-side retries, and no
 * catch-and-continue around loader failures.
 */
import type { RuntimeManifest } from './runtime-manifest.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { FacetHost } from './facet-host.js';
import { type NimbusFilesystemAuthority } from './os-contracts.js';
/** Build the runner factory. Closes over the facet host and the filesystem authority. */
export declare function makeClangRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export declare const CLANG_RUNNER_PREAMBLE: string;
//# sourceMappingURL=clang-runner.d.ts.map