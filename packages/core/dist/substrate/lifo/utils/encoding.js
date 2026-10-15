// UTF-8 and concatenation for lifo's commands and its archive code, over the
// shared codecs and concatenator (_shared/bytes.ts). A public subpath of
// core: its variadic concatBytes stays.
import { concatBytes as concatParts, dec, enc } from '../../../_shared/bytes.js';
export function encode(str) {
    return enc.encode(str);
}
export function decode(bytes) {
    return dec.decode(bytes);
}
export function concatBytes(...arrays) {
    return concatParts(arrays);
}
