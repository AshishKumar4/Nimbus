/**
 * tarball-integrity.ts — reading a tarball's subresource-integrity string
 * (`<algorithm>-<base64 digest>`) and checking bytes against it, for every
 * place that does: the worker's install facet and the shell's fallback npm
 * (lifo commands/system/npm.ts), which verify what they download, and the
 * shared tarball cache (worker npm/r2-cache.ts), which addresses what it
 * stores.
 *
 * One reading, two rules on top of it:
 *   - an install checks the entry of the strongest algorithm the string
 *     names, as npm's ssri does, and skips (with a warning) a string that
 *     names none it knows;
 *   - the cache addresses only a string that is one entry, whose digest
 *     decodes: it stores nothing it could not verify the same way twice.
 *
 * Self-contained but for SRI_DIGEST_ALGORITHMS, which the functions name:
 * the install facet carries all of them by source (its preamble, worker
 * loaders/npm-install-preamble.ts).
 */
/** The SRI algorithms npm emits, weakest first, by their Web Crypto names. */
export declare const SRI_DIGEST_ALGORITHMS: Readonly<Record<string, string>>;
/** One entry of an SRI string, of an algorithm npm emits. */
export interface SriEntry {
    /** Lowercase SRI algorithm name (e.g. 'sha512'). */
    algo: string;
    /** Its Web Crypto name (e.g. 'SHA-512'). */
    digestAlgo: string;
    /** The digest, base64 as written. */
    digest: string;
}
/** The entries of `integrity` whose algorithm npm emits, in order; the rest are ignored, as ssri ignores them. */
export declare function sriEntries(integrity: string): SriEntry[];
/** The entry an install checks: the strongest algorithm's, the first of its entries; null when there is none. */
export declare function strongestSriEntry(integrity: string): SriEntry | null;
/** `bytes`' digest under `digestAlgo`, base64. */
export declare function sriDigestOf(bytes: Uint8Array, digestAlgo: string): Promise<string>;
/** Whether two base64 digests name the same bytes; a digest that does not decode matches nothing. */
export declare function sriDigestsEqual(a: string, b: string): boolean;
//# sourceMappingURL=tarball-integrity.d.ts.map