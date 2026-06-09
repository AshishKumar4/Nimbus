export interface ArgSpec {
    [key: string]: {
        type: 'boolean' | 'string';
        short?: string;
    };
}
export interface ParsedArgs {
    flags: Record<string, string | boolean>;
    positional: string[];
}
export declare function parseArgs(args: string[], spec: ArgSpec): ParsedArgs;
//# sourceMappingURL=args.d.ts.map