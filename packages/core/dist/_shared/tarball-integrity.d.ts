/**
 * tarball-integrity.ts — reading a tarball's subresource-integrity string
 * (`<algorithm>-<base64 digest>`) and checking bytes against it, for every
 * place that does: the worker's install facet and the shell's fallback npm
 * (lifo commands/system/npm.ts), which verify what they download, and the
 * shared tarball cache (worker npm/r2-cache.ts), which addresses what it
 * stores.
 *
 * One reading, two rules on top of it. The reading ignores an entry of an
 * algorithm npm does not emit, as ssri does, and refuses (throws) an entry
 * of one it does whose digest is not that algorithm's: empty, not base64, or
 * the wrong length. Such a string is broken or forged, and passing over the
 * entry would skip the check or fall back to a weaker one.
 *   - an install checks the entry of the strongest algorithm the string
 *     names, as npm's ssri does, skips (with a warning) a string that names
 *     none it knows, and fails on one the reading refuses;
 *   - the cache addresses only a string that is one entry the reading
 *     accepts: it stores nothing it could not verify the same way twice.
 *
 * Each function names only the others: the install facet carries them all by
 * source (its preamble, worker loaders/npm-install-preamble.ts), which keeps
 * the identifiers the Worker's bundler gives them only for functions.
 */
/** The SRI algorithms npm emits, weakest first, by their Web Crypto names. */
export declare function sriDigestAlgorithms(): Readonly<Record<string, string>>;
/** One entry of an SRI string, of an algorithm npm emits. */
export interface SriEntry {
    /** Lowercase SRI algorithm name (e.g. 'sha512'). */
    algo: string;
    /** Its Web Crypto name (e.g. 'SHA-512'). */
    digestAlgo: string;
    /** The digest, base64 as written. */
    digest: string;
}
/**
 * The entries of `integrity` whose algorithm npm emits, in order; the rest
 * are ignored, as ssri ignores them. Throws for an entry of such an
 * algorithm whose digest does not decode to one of that algorithm's length.
 */
export declare function sriEntries(integrity: string): SriEntry[];
/** The entry an install checks: the strongest algorithm's, the first of its entries; null when there is none. */
export declare function strongestSriEntry(integrity: string): SriEntry | null;
/** `bytes`' digest under `digestAlgo`, base64. */
export declare function sriDigestOf(bytes: Uint8Array, digestAlgo: string): Promise<string>;
/** Whether two base64 digests name the same bytes; a digest that does not decode matches nothing. */
export declare function sriDigestsEqual(a: string, b: string): boolean;
//# sourceMappingURL=tarball-integrity.d.ts.map