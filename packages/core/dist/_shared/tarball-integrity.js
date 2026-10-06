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
export const SRI_DIGEST_ALGORITHMS = {
    sha1: 'SHA-1',
    sha256: 'SHA-256',
    sha384: 'SHA-384',
    sha512: 'SHA-512',
};
/** The entries of `integrity` whose algorithm npm emits, in order; the rest are ignored, as ssri ignores them. */
export function sriEntries(integrity) {
    const entries = [];
    if (typeof integrity !== 'string')
        return entries;
    for (const token of integrity.split(/\s+/)) {
        const dash = token.indexOf('-');
        if (dash <= 0)
            continue;
        const algo = token.slice(0, dash).toLowerCase();
        const digestAlgo = Object.prototype.hasOwnProperty.call(SRI_DIGEST_ALGORITHMS, algo) ? SRI_DIGEST_ALGORITHMS[algo] : undefined;
        const digest = token.slice(dash + 1);
        if (digestAlgo !== undefined && digest)
            entries.push({ algo, digestAlgo, digest });
    }
    return entries;
}
/** The entry an install checks: the strongest algorithm's, the first of its entries; null when there is none. */
export function strongestSriEntry(integrity) {
    const rank = Object.keys(SRI_DIGEST_ALGORITHMS);
    let best = null;
    for (const entry of sriEntries(integrity)) {
        if (best === null || rank.indexOf(entry.algo) > rank.indexOf(best.algo))
            best = entry;
    }
    return best;
}
/** `bytes`' digest under `digestAlgo`, base64. */
export async function sriDigestOf(bytes, digestAlgo) {
    const digest = new Uint8Array(await crypto.subtle.digest(digestAlgo, bytes));
    let binary = '';
    for (let i = 0; i < digest.length; i++)
        binary += String.fromCharCode(digest[i]);
    return btoa(binary);
}
/** Whether two base64 digests name the same bytes; a digest that does not decode matches nothing. */
export function sriDigestsEqual(a, b) {
    try {
        return atob(a) === atob(b);
    }
    catch {
        return false;
    }
}
