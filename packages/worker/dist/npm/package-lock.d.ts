/**
 * npm's package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3),
 * read for `npm ci`: the `packages` map keyed by install path.
 */
/** A parsed JSON object or array: a value whose fields can be read and set. */
export declare function isJsonObject(value: unknown): value is Record<string, unknown>;
export interface PackageLockEntry {
    name?: unknown;
    version?: unknown;
    resolved?: unknown;
    integrity?: unknown;
    link?: unknown;
    dev?: unknown;
    optional?: unknown;
    devOptional?: unknown;
    extraneous?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
    peerDependenciesMeta?: unknown;
    bundleDependencies?: unknown;
    /** Carried in its bundler's archive. */
    inBundle?: unknown;
    bin?: unknown;
    os?: unknown;
    cpu?: unknown;
    libc?: unknown;
}
export interface PackageLock {
    lockfileVersion: number;
    packages: Record<string, PackageLockEntry>;
}
export declare function parsePackageLock(text: string, lockName: string): PackageLock;
export declare function stringRecord(value: unknown): Record<string, string>;
export declare function stringList(value: unknown): string[] | undefined;
//# sourceMappingURL=package-lock.d.ts.map