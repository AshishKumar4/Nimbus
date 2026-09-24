export interface PackageLockEntry {
    name?: unknown;
    version?: unknown;
    resolved?: unknown;
    integrity?: unknown;
    link?: unknown;
    dev?: unknown;
    optional?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
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
/**
 * Why the lock no longer describes package.json, one line per disagreement;
 * empty when they agree. Every declared dependency must be locked at a
 * version its range accepts, and the lock's root must declare the same
 * dependency set, so a dependency removed from package.json is caught too.
 */
export declare function packageLockMismatches(pkgJson: Record<string, unknown>, lock: PackageLock): string[];
export declare function stringRecord(value: unknown): Record<string, string>;
export declare function stringList(value: unknown): string[] | undefined;
//# sourceMappingURL=package-lock.d.ts.map