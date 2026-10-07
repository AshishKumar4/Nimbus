import { SerializationError } from './errors.js';
export function serializeFunction(fn) {
    if (typeof fn !== 'function') {
        throw new SerializationError(`Expected a function, got ${typeof fn}`);
    }
    const source = fn.toString();
    if (source.includes('[native code]')) {
        throw new SerializationError(`Cannot serialize native function: ${fn.name || '(anonymous)'}. ` +
            'Only user-defined functions can be dispatched to remote isolates.');
    }
    // `this` has no receiver in the remote isolate — reject it early.
    if (/\bthis\b/.test(source)) {
        throw new SerializationError(`Function "${fn.name || '(anonymous)'}" references \`this\`, which is ` +
            'not available in a remote isolate. Pass values as explicit arguments instead.');
    }
    return source;
}
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
/**
 * A 32-bit hash of every byte of `buffer`, for loader cache keys over
 * multi-MiB wasm images: two multiply-xorshift lanes over its 32-bit words,
 * then the tail bytes, the length and murmur3's finalizer. Not
 * cryptographic. Words are read in the host's byte order; a cache key only
 * has to agree with itself on one host.
 */
export function hashBytes(buffer) {
    const whole = buffer.byteLength & ~7;
    const words = new Uint32Array(buffer, 0, whole >>> 2);
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < words.length; i += 2) {
        a = Math.imul(a ^ words[i], 0x85ebca6b);
        a ^= a >>> 13;
        b = Math.imul(b ^ words[i + 1], 0xc2b2ae35);
        b ^= b >>> 16;
    }
    const tail = new Uint8Array(buffer, whole);
    for (let i = 0; i < tail.length; i++) {
        a = Math.imul(a ^ tail[i], 0x85ebca6b);
        a ^= a >>> 13;
    }
    let hash = a ^ Math.imul(b, 0x27d4eb2d) ^ buffer.byteLength;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}
