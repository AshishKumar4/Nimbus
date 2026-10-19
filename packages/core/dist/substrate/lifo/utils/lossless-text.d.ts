/**
 * {@link decodeLossless} across writes: a sequence a write leaves unfinished
 * is held for the next, so a character split between writes decodes whole;
 * what is held at the end decodes byte by byte, as decodeLossless has it.
 */
export declare class LosslessDecoder {
    private held;
    decode(bytes: Uint8Array): string;
    end(): string;
}
/**
 * Bytes as a string without loss: valid UTF-8 decodes to its characters,
 * and every byte of an invalid sequence to U+DC80 + byte (a lone surrogate,
 * which valid UTF-8 never produces). `encodeLossless` inverts it exactly.
 */
export declare function decodeLossless(bytes: Uint8Array): string;
/** The length of the valid UTF-8 sequence at `i`, or 0. */
export declare function utf8SequenceLength(bytes: Uint8Array, i: number): number;
/**
 * `head` then `tail`, lossless text joined as their bytes join. A high
 * surrogate ending `head` is half a character (the shell can cut one), and
 * a byte (U+DC80..U+DCFF) starting `tail` would read as its other half: that
 * half goes as what it encodes to alone, U+FFFD, and the byte stays a byte.
 */
export declare function joinLossless(head: string, tail: string): string;
/** Where the first byte decodeLossless kept as U+DC80 + byte is in `text`, or -1. */
export declare function firstLosslessByte(text: string): number;
/** The inverse of `decodeLossless`. */
export declare function encodeLossless(text: string): Uint8Array;
//# sourceMappingURL=lossless-text.d.ts.map