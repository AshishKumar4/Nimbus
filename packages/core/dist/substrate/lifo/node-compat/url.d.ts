export * from 'node:url';
export { default } from 'node:url';
/**
 * The engine's url against the program's working directory: pathToFileURL of
 * a relative path starts from `cwd`, as Node's starts from process.cwd(), the
 * engine's own process's, which is not the program's.
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
//# sourceMappingURL=url.d.ts.map