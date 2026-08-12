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
export declare function parseArgs(args: string[], spec: ArgSpec): ParsedArgs;
//# sourceMappingURL=args.d.ts.map