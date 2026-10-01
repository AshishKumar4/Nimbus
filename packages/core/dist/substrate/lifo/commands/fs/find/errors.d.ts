/**
 * A command line GNU find refuses: its message (after `find: `), any lines
 * GNU prints after it as they are, and exit status 1, before any file is visited.
 */
export declare class FindUsageError extends Error {
    readonly continuation: readonly string[];
    constructor(message: string, continuation?: readonly string[]);
}
/**
 * A file name in a diagnostic, as gnulib's locale quoting style writes it in
 * the C locale: in single quotes, with quotes, backslashes and control
 * characters escaped (`'it\'s'`, `'a\tb'`).
 */
export declare function quote(name: string): string;
//# sourceMappingURL=errors.d.ts.map