/**
 * posix-path.ts — node:path's posix half, as Node v22.22.3's lib/path.js
 * computes it, on built-ins captured before any program code runs
 * (primordials.ts): the guest's node:path, which its module loading calls
 * too, answers as Node's does after a program replaced
 * String.prototype.charCodeAt or Array.prototype.join, as Node's own path,
 * written against its primordials, does. Ported line for line; what Node's
 * reads from the process (its working directory) the caller gives.
 * `matchesGlob` (minimatch's) and `win32` are the platform's, which the
 * caller sets where Node's are, in Node's order of keys.
 */
/** The parts path.format joins, a program's object: each read as Node reads it, its own or inherited. */
export interface ParsedPath {
    root: string | undefined;
    dir: string | undefined;
    base: string | undefined;
    name: string | undefined;
    ext: string | undefined;
}
/** node:path's posix functions, `cwd` the working directory resolution starts from. */
export interface PosixPath {
    resolve(...args: string[]): string;
    normalize(path: string): string;
    isAbsolute(path: string): boolean;
    join(...args: string[]): string;
    relative(from: string, to: string): string;
    toNamespacedPath(path: string): string;
    dirname(path: string): string;
    basename(path: string, suffix?: string): string;
    extname(path: string): string;
    format: (pathObject: ParsedPath) => string;
    parse(path: string): {
        root: string;
        dir: string;
        base: string;
        ext: string;
        name: string;
    };
    matchesGlob: ((path: string, pattern: string) => boolean) | null;
    sep: '/';
    delimiter: ':';
    win32: object | null;
    posix: PosixPath | null;
    _makeLong: ((path: string) => string) | null;
}
/** Node's path.posix, resolving from `cwd()`. */
export declare function createPosixPath(cwd: () => string): PosixPath;
//# sourceMappingURL=posix-path.d.ts.map