import type { PlatformPath } from 'node:path';
/** The engine's path, whose resolve and relative (posix and win32) start from `cwd`. */
export declare function createPath(cwd: string): PlatformPath;
/**
 * The engine's url, whose pathToFileURL of a relative path starts from `cwd`,
 * in the path platform the call asks for (Windows mode: drive and UNC paths
 * are absolute, a drive-relative one is its drive's).
 */
export declare function createUrl(cwd: string): {
    pathToFileURL: (path: string, options?: {
        windows?: boolean;
    }) => URL;
    fileURLToPath(url: string | URL, options?: {
        windows?: boolean;
    }): string;
    default: {
        pathToFileURL: typeof import("node:url").pathToFileURL;
        fileURLToPath: typeof import("node:url").fileURLToPath;
    };
};
//# sourceMappingURL=cwd-relative.d.ts.map