/**
 * Sizes as GNU's tools read and print them: one parser (gnulib's
 * xstrtoumax) and one printer (gnulib's human_readable), each tool passing
 * the suffix letters it accepts, as coreutils' callers pass theirs.
 */
/**
 * `text` as a count, as xstrtoumax reads it: optional blanks and `+`, digits
 * (in base 0, `0x` hex and leading-zero octal too), then at most one of the
 * letters in `suffixes`. A suffix with no digits before it counts one (`M`
 * is 1 MiB). Where `suffixes` holds `0`, the letter may be followed by `B`
 * (powers of 1000) or `iB` (of 1024, as the letter alone is). Null when
 * `text` is not such a count; a count too large for a double is Infinity.
 *
 * coreutils' tables: head and tail `bkKmMGTPEZYRQ0`, od `bEGKkMmPQRTYZ0`,
 * dd `bcEGkKMPQRTwYZ0`, du -B `EgGkKmMPtTYZ0`, du -t `kKmMGTPEZYRQ0` (as coreutils 9.7
 * answers each).
 */
export declare function parseSuffixedCount(text: string, suffixes: string, base?: 10 | 0): number | null;
/**
 * `bytes` as gnulib's human_readable prints it for du -h and df -h (ceiling,
 * autoscale): in `base` 1024 (K, M, ...) or 1000 (k, M, ...), rounded up,
 * with one decimal below 10. Integer arithmetic throughout, as gnulib's, so
 * the rounding is its rounding.
 */
export declare function humanReadable(bytes: number, base: 1024 | 1000): string;
//# sourceMappingURL=size-units.d.ts.map