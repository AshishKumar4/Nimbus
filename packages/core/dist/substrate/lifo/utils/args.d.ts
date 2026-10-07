/**
 * Command-line options: one scanner (`scanOptions`, getopt_long's grammar)
 * and two policies over it. `getopt` is GNU's: an option it cannot take ends
 * the scan with getopt's own diagnostic. `parseArgs` is the compatibility
 * collector the flag-table commands use: exact long names, unknown options
 * set aside for the command to judge, a missing value read as ''.
 */
/** How a GNU long option takes its argument. */
export type LongArgument = 'none' | 'required' | 'optional';
/**
 * A command's options as GNU getopt_long reads them: `short` is the
 * optstring (a letter, `:` after one that takes an argument); `long` maps
 * each long name to the key its events carry (a short letter it aliases, or
 * a name of its own) and how it takes an argument.
 */
export interface GetoptSpec {
    readonly short: string;
    readonly long: Readonly<Record<string, readonly [key: string, argument: LongArgument]>>;
}
/**
 * One step of a scan: an option (by key, with its argument) or an operand;
 * or an option the spec cannot take: one it does not have (`option` is `-x`
 * or `--name`, `written` the whole word), an ambiguous prefix, one that needs
 * an argument and is the last word, or a long one given an argument it does
 * not take. The scan goes on after each; a policy decides what it means.
 */
export type ScanEvent = {
    readonly kind: 'option';
    readonly key: string;
    readonly value?: string;
} | {
    readonly kind: 'operand';
    readonly value: string;
} | {
    readonly kind: 'unknown';
    readonly option: string;
    readonly written: string;
} | {
    readonly kind: 'ambiguous';
    readonly written: string;
    readonly candidates: readonly string[];
} | {
    readonly kind: 'missing';
    readonly key: string;
    readonly option: string;
} | {
    readonly kind: 'unwanted';
    readonly key: string;
    readonly option: string;
    readonly value: string;
};
/**
 * `args` scanned as GNU getopt_long scans them, permuting: options and
 * operands may interleave, `--` ends the options, `-` is an operand. A
 * cluster (`-cz`) is its letters; a letter that takes an argument takes the
 * rest of its word or the next word (`-k2`, `-k 2`). A long option is its
 * name, or with `abbreviations` an unambiguous prefix of one (`--coun`); its
 * argument follows `=` or, when required, is the next word.
 */
export declare function scanOptions(args: readonly string[], spec: GetoptSpec, { abbreviations }?: {
    abbreviations?: boolean;
}): Generator<ScanEvent>;
/** An option or an operand, or the diagnostic GNU getopt prints for a bad option. */
export type GetoptEvent = {
    readonly kind: 'option';
    readonly key: string;
    readonly value?: string;
} | {
    readonly kind: 'operand';
    readonly value: string;
} | {
    readonly kind: 'error';
    readonly message: string;
};
/**
 * `args` as GNU getopt_long reads them (scanOptions with abbreviations): the
 * scan ends at the first option it cannot take, with getopt's own
 * diagnostic, which the command prefixes with its name.
 */
export declare function getopt(args: readonly string[], spec: GetoptSpec): Generator<GetoptEvent>;
export interface ArgSpec {
    [key: string]: {
        type: 'boolean' | 'string';
        short?: string;
    };
}
export interface ParsedArgs {
    flags: Record<string, string | boolean>;
    positional: string[];
    /**
     * Options the spec does not declare, in the spelling the caller used —
     * `-z` for a short inside a cluster, `--zap` for a long. Commands that
     * reject unknown options the way GNU does read this; the rest ignore it.
     */
    unknown: string[];
}
/**
 * A flag table's options, collected: scanOptions over the table without
 * abbreviations, every flag present (false, or '' for a string); an
 * undeclared option is set aside in `unknown`, a string option with nothing
 * after it is '', and a boolean given `--name=value` is true.
 */
export declare function parseArgs(args: string[], spec: ArgSpec): ParsedArgs;
//# sourceMappingURL=args.d.ts.map