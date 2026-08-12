export interface NpmInstallInvocation {
    packages: string[];
    global: boolean;
    prefix: string | null;
    /**
     * Options this implementation does not know. npm warns and carries on
     * rather than failing, so we do too — but the caller must print them.
     * Dropping them silently is what makes a wrong install look like a right one.
     */
    unknownOptions: string[];
}
export declare function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation;
//# sourceMappingURL=install-args.d.ts.map