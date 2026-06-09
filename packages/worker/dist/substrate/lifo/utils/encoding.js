const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function encode(str) {
    return encoder.encode(str);
}
export function decode(bytes) {
    return decoder.decode(bytes);
}
export function concatBytes(...arrays) {
    const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
