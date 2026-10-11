/**
 * djb2 over a string's UTF-16 code units, as an unsigned 32-bit integer:
 * fast, deterministic, not cryptographic. Behind loader cache keys and peer
 * placement.
 */
export function djb2(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++)
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return hash >>> 0;
}
/** {@link djb2} of `source` in base 36, for loader cache keys. */
export function hashSource(source) {
    return djb2(source).toString(36);
}
