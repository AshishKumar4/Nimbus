/**
 * POSIX path operations -- pure string manipulation, no I/O.
 */
export declare function normalize(path: string): string;
export declare function isAbsolute(path: string): boolean;
export declare function join(...segments: string[]): string;
export declare function resolve(cwd: string, ...segments: string[]): string;
/** A filesystem operand: the walk, not a string reduction, interprets its components. */
export declare function operandPath(cwd: string, operand: string): string;
export declare function dirname(path: string): string;
export declare function basename(path: string, ext?: string): string;
export declare function extname(path: string): string;
export declare function split(path: string): string[];
/** The path from absolute `from` to absolute `to`, as POSIX path.relative answers it. */
export declare function relative(from: string, to: string): string;
//# sourceMappingURL=path.d.ts.map