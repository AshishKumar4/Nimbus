import { type NpmLogLevel } from './npm-log.js';
export interface NpmInstallInvocation {
    packages: string[];
    global: boolean;
    prefix: string | null;
    /** `--loglevel`, when it names a level npm recognises; null otherwise. */
    loglevel: NpmLogLevel | null;
}
export declare function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation;
//# sourceMappingURL=install-args.d.ts.map