/**
 * npm-tarball-stream.ts — pure streaming tar primitives.
 *
 * Extracted from npm-tarball.ts so these helpers can be esbuild-bundled
 * WITHOUT dragging in NpmCache / NpmResolver / SqliteVFS. Consumed by
 * scripts/bundle-facet-workers.mjs which emits a string constant the
 * NimbusLoaderPool uses to inject the tar parser into dynamic workers.
 *
 * Zero dependencies. Works identically on the supervisor and inside a
 * facet isolate. Never buffers the full decompressed tarball — peak
 * transient heap is one file's bytes plus a 512-byte carry.
 */
/**
 * Maximum size of a single file inside a tarball. Larger entries are skipped.
 *
 * History: 5 MB was too low — it silently dropped `esbuild-wasm/esbuild.wasm`
 * (11.35 MB on v0.24.2), which made Nimbus-in-Nimbus `npm run dev` fail with
 * `No such module "esbuild-wasm/esbuild.wasm"` since the missing file caused
 * esbuild's VFS plugin to mark the import `external`, and workerd's LOADER
 * has no entry for that specifier. 20 MB covers esbuild-wasm with headroom
 * while keeping per-facet peak heap bounded for the streaming extractor.
 */
export declare const MAX_FILE_BYTES = 20000000;
/**
 * Read one tar header (USTAR) out of `block`. Returns parsed fields or
 * `null` for an end-of-archive block (all zeros).
 */
/**
 * Collapse "."/".." segments in a tar entry's package-relative path.
 * Returns the canonical relative path, or '' when the entry escapes its
 * package root (a leading ".." that pops above the root) — the caller
 * treats '' as a no-name entry and skips it. Mirrors the segment logic in
 * w7-frame's canonicalPath so joined write paths are always accepted.
 */
export declare function canonicalTarName(name: string): string;
export declare function parseTarHeader(block: Uint8Array): {
    name: string;
    size: number;
    typeFlag: number;
} | null;
/**
 * Wrap a `ReadableStream<Uint8Array>` as an async iterable. Workerd and
 * Node both support `Symbol.asyncIterator` on ReadableStream, but we
 * spell the reader loop out so we don't depend on ambient lib typings.
 */
export declare function readableStreamToAsyncIterable(rs: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined>;
/**
 * Reason a tar entry was skipped and never yielded. Surfaced to callers
 * via the optional `onSkip` callback on `streamTarEntries`.
 *
 * - 'too-large': size > MAX_FILE_BYTES. The most common reason Nimbus
 *   cares about — it's what caused esbuild-wasm/esbuild.wasm to vanish
 *   silently in Nimbus-in-Nimbus before the cap was raised.
 * - 'non-regular': typeFlag indicates a symlink / hardlink / directory /
 *   PaxHeader / GNU LongName etc. These aren't files we stage.
 * - 'no-name': header parsed but name was empty (malformed or a PaxHeader
 *   that our parser didn't recognize as non-regular).
 */
export type TarSkipReason = 'too-large' | 'non-regular' | 'no-name';
/**
 * Optional skip-observer passed to `streamTarEntries`. Called ONCE per
 * skipped entry, with the declared name (may be empty for 'no-name'
 * skips) and the declared size in bytes.
 *
 * Consumers typically push these into a per-package warnings array so
 * users see what wasn't installed. The callback is synchronous and
 * must not throw — thrown errors are swallowed to keep the extractor
 * best-effort.
 */
export type TarSkipCallback = (name: string, size: number, reason: TarSkipReason) => void;
/**
 * Streaming tar extractor.
 *
 * Consumes an async iterable of Uint8Array chunks (the decompressed tar
 * byte stream) and yields one `{ name, data }` entry per regular file,
 * as each file completes.
 *
 * Memory invariant: holds at most one pending file's bytes (≤ MAX_FILE_BYTES)
 * plus a small carry buffer for the tar header being assembled.
 *
 * Skips: symlinks, directories, hardlinks, long-name extensions (PaxHeader),
 * and any file whose declared size exceeds MAX_FILE_BYTES.
 *
 * If `onSkip` is provided, it is invoked for each skipped entry with the
 * name, declared size, and reason code. Callers that need to surface
 * dropped-file warnings to users should pass one; legacy callers that
 * omit the arg still behave exactly as before (silent skip).
 */
export declare function streamTarEntries(source: AsyncIterable<Uint8Array>, onSkip?: TarSkipCallback): AsyncGenerator<{
    name: string;
    data: Uint8Array;
}, void, undefined>;
//# sourceMappingURL=tarball-stream.d.ts.map