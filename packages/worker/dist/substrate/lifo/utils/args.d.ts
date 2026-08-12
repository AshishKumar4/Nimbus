/**
 * Strict getopt-shaped option parsing, shared by the substrate commands and
 * the `unix-commands` implementations that override them.
 *
 * The contract that matters: an option this command does not implement is an
 * ERROR, never a silently dropped argument. Dropping it produces confidently
 * wrong output — `stat -c '%s'` used to treat the format string as a filename
 * — and a caller cannot tell that apart from the command having worked.
 *
 * Diagnostics match GNU getopt verbatim so the text a caller matches against a
 * real tool keeps matching here:
 *
 *   prog: unrecognized option '--bogus'
 *   prog: invalid option -- 'Q'
 *   prog: option '--format' requires an argument
 *   prog: option requires an argument -- 'c'
 */
export interface ArgSpec {
    [long: string]: {
        type: 'boolean' | 'string';
        /** Short aliases, one character each: `'r'`, or `'rR'` for `rm -r`/`-R`. */
        short?: string;
    };
}
export interface ParseOptions {
    /**
     * Long flag set by the obsolete bare-number form (`tail -5`, `strings -8`).
     * Only the commands GNU gives that form declare it; elsewhere `-5` stays an
     * invalid option, which is what GNU does.
     */
    numericShorthand?: string;
    /**
     * Collect unknown options into `unknown` instead of refusing. For `npm`,
     * which warns (`Unknown cli config "--x"`) and carries on rather than
     * failing — the caller must still surface them, never drop them.
     */
    tolerateUnknown?: boolean;
    /**
     * Accept `--flag=false` for boolean options. npm's config layer takes a
     * value for every key; GNU getopt refuses one on a boolean, so this is
     * opt-in per command rather than the default.
     */
    booleanValues?: boolean;
}
export type ParsedArgs = {
    ok: true;
    flags: Record<string, string | boolean>;
    positional: string[];
    /** Non-empty only under `tolerateUnknown`; the caller must report these. */
    unknown: string[];
} | {
    ok: false;
    error: string;
};
export declare function parseArgs(name: string, args: string[], spec: ArgSpec, options?: ParseOptions): ParsedArgs;
//# sourceMappingURL=args.d.ts.map