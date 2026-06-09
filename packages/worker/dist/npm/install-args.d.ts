export interface NpmInstallInvocation {
    packages: string[];
    global: boolean;
    prefix: string | null;
}
export declare function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation;
//# sourceMappingURL=install-args.d.ts.map