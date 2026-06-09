/**
 * POSIX path operations -- pure string manipulation, no I/O.
 */
export declare function normalize(path: string): string;
export declare function isAbsolute(path: string): boolean;
export declare function join(...segments: string[]): string;
export declare function resolve(cwd: string, ...segments: string[]): string;
export declare function dirname(path: string): string;
export declare function basename(path: string, ext?: string): string;
export declare function extname(path: string): string;
export declare function split(path: string): string[];
//# sourceMappingURL=path.d.ts.map