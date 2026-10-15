// UTF-8 and concatenation for lifo's commands and its archive code, over the
// shared codecs and concatenator (_shared/bytes.ts). A public subpath of
// core: its variadic concatBytes stays.
import { concatBytes as concatParts, dec, enc } from '../../../_shared/bytes.js';

export function encode(str: string): Uint8Array {
  return enc.encode(str);
}

export function decode(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  return concatParts(arrays);
}
