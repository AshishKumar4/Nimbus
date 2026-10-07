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
export function sriDigestAlgorithms() {
    return { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
}
/**
 * The entries of `integrity` whose algorithm npm emits, in order; the rest
 * are ignored, as ssri ignores them. Throws for an entry of such an
 * algorithm whose digest does not decode to one of that algorithm's length.
 */
export function sriEntries(integrity) {
    const entries = [];
    if (typeof integrity !== 'string')
        return entries;
    for (const token of integrity.split(/\s+/)) {
        const dash = token.indexOf('-');
        if (dash <= 0)
            continue;
        const algo = token.slice(0, dash).toLowerCase();
        const algorithms = sriDigestAlgorithms();
        const digestAlgo = Object.prototype.hasOwnProperty.call(algorithms, algo) ? algorithms[algo] : undefined;
        if (digestAlgo === undefined)
            continue;
        // Options after `?` are not the digest (ssri's reading).
        const digest = token.slice(dash + 1).split('?')[0];
        let bytes = -1;
        try {
            bytes = atob(digest).length;
        }
        catch { /* not base64: refused below */ }
        if (bytes !== (digestAlgo === 'SHA-1' ? 20 : Number(digestAlgo.slice(4)) / 8)) {
            throw new Error(`malformed integrity "${token}": not a ${algo} digest`);
        }
        entries.push({ algo, digestAlgo, digest });
    }
    return entries;
}
/** The entry an install checks: the strongest algorithm's, the first of its entries; null when there is none. */
export function strongestSriEntry(integrity) {
    const rank = Object.keys(sriDigestAlgorithms());
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
