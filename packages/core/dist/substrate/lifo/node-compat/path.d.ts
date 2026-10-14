import type { PlatformPath } from 'node:path';
export * from 'node:path';
export { default } from 'node:path';
/**
 * The engine's path against the program's working directory: resolve and
 * relative start from `cwd`, as Node's start from process.cwd(), the
 * engine's own process's, which is not the program's.
 */
export declare function createPath(cwd: string): PlatformPath;
//# sourceMappingURL=path.d.ts.map