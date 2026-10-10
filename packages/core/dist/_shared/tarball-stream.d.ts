/**
 * tarball-stream.ts — pure streaming tar primitives.
 *
 * A leaf with no imports at all, deliberately: `bundle-facet-workers.mjs`
 * esbuilds this file into a string constant the loader pool injects into
 * dynamic workers, and a facet isolate resolves no specifier. Anything this
 * file imported would have to travel with it.
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
 * Collapse "."/".." segments in a tar entry's package-relative path.
 * Returns the canonical relative path, or '' when the entry escapes its
 * package root (a leading ".." that pops above the root) — the caller
 * treats '' as a no-name entry and skips it. Mirrors the segment logic in
 * w7-frame's canonicalPath so joined write paths are always accepted.
 */
export declare function canonicalTarName(name: string): string;
/** One tar (USTAR) header. */
export interface TarHeader {
    /** The entry's path, its prefix field joined on, canonical (canonicalTarName): '' when it escapes the archive's root. */
    name: string;
    size: number;
    typeFlag: number;
    mode: number;
    /** Modification time, in seconds since the epoch. */
    mtime: number;
    /** Whether the entry is a directory: type '5', or a name ending in '/'. */
    directory: boolean;
}
/**
 * Read one tar header (USTAR) out of `block`, or null for an end-of-archive
 * block. Names are UTF-8, as tar writes them today.
 */
export declare function parseTarHeader(block: Uint8Array): TarHeader | null;
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
/** An archive held whole in memory, as the stream streamTarRecords reads. */
export declare function tarBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array, void, undefined>;
/** Whether `header` is a regular file's: type '0', or NUL as old tars wrote it. */
export declare function isRegularTarFile(header: TarHeader): boolean;
/**
 * Every entry of a tar stream, in order, each as its data completes: its
 * header, and its data when `read(header)` asks for it, else null (the data
 * is passed over unread). An extraction's policy is its `read`.
 *
 * Consumes an async iterable of Uint8Array chunks (the decompressed tar
 * byte stream). Memory invariant: holds at most one pending entry's bytes
 * plus a small carry buffer for the tar header being assembled.
 */
export declare function streamTarRecords(source: AsyncIterable<Uint8Array>, read: (header: TarHeader) => boolean): AsyncGenerator<{
    header: TarHeader;
    data: Uint8Array | null;
}, void, undefined>;
/**
 * The regular files of a tar stream, `{ name, data }`, as each completes:
 * npm's policy over streamTarRecords.
 *
 * Skips: symlinks, directories, hardlinks, long-name extensions (PaxHeader),
 * and any file whose declared size exceeds MAX_FILE_BYTES.
 *
 * If `onSkip` is provided, it is invoked for each skipped entry that
 * carries bytes with the name, declared size, and reason code. Callers that
 * need to surface dropped-file warnings to users should pass one; legacy
 * callers that omit the arg still behave exactly as before (silent skip).
 */
export declare function streamTarEntries(source: AsyncIterable<Uint8Array>, onSkip?: TarSkipCallback): AsyncGenerator<{
    name: string;
    data: Uint8Array;
}, void, undefined>;
/**
 * Stream the files of an npm package tarball, package-relative.
 *
 * npm wraps every package in ONE top-level directory whose name is the
 * publisher's choice — registry convention is `package/`, but live
 * tarballs ship other roots (@types/node@26 carries `node/`). This
 * learns the prefix from the first entry's top-level component and
 * strips it from every entry, so `<root>/package.json` yields
 * `package.json` and an entry named exactly `<root>` yields nothing —
 * the root directory itself carries no bytes to write.
 *
 * An entry under a different top-level component means the archive is
 * not a single-rooted package (or tries to smuggle a sibling of the
 * root); the generator throws rather than extract it.
 *
 * Only regular-file entries carry the prefix check — directory, link and
 * metadata records are skipped inside streamTarEntries before they reach
 * here, so a PaxHeader like `./PaxHeaders/x` can never poison the learned
 * prefix.
 */
export declare function streamPackageEntries(source: AsyncIterable<Uint8Array>, onSkip?: TarSkipCallback): AsyncGenerator<{
    name: string;
    data: Uint8Array;
}, void, undefined>;
//# sourceMappingURL=tarball-stream.d.ts.map