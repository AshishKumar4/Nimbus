/**
 * Tarball extraction for streaming installers and buffered archive consumers.
 *
 * The streaming primitives it walks with (`parseTarHeader`, `streamTarEntries`,
 * `readableStreamToAsyncIterable`) live in `./tarball-stream.ts` — a
 * dependency-free leaf, because `bundle-facet-workers.mjs` esbuilds that file
 * into a string the loader pool injects into dynamic workers, where an import
 * would not resolve.
 *
 * Installers use writeTarballStream. extractTarball retains a map for callers
 * such as gem install, which must open an archive nested inside another one.
 */
export interface TarballWriteTarget {
    exists(path: string): boolean;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): void;
    writeFile(path: string, data: Uint8Array | string): unknown;
}
export interface TarballWriteResult {
    /** Regular files written, including the manifest. */
    files: number;
    /** Total decompressed bytes written. */
    bytes: number;
}
/**
 * Stream a gzipped npm archive into a package directory. Entry names are
 * already canonical and prefix-stripped by streamTarEntries. Hold only the
 * current entry and the manifest; write the manifest last so a failed install
 * is not mistaken for a complete package on retry. Filesystem failures reject.
 */
export declare function writeTarballStream(body: ReadableStream<Uint8Array>, targetDir: string, vfs: TarballWriteTarget): Promise<TarballWriteResult>;
/** Extract every regular file. Gzipped input is decompressed first. */
export declare function extractTarball(tarball: ArrayBuffer): Promise<Map<string, Uint8Array>>;
//# sourceMappingURL=tarball.d.ts.map