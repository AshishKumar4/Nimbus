import { type NpmLogLevel } from './npm-log.js';
export interface NpmInstallInvocation {
    packages: string[];
    global: boolean;
    prefix: string | null;
    /** `--loglevel`, when it names a level npm recognises; null otherwise. */
    loglevel: NpmLogLevel | null;
    /**
     * `--production` / `-p` / `--omit=dev`: install dependencies only.
     *
     * Both npm and bun honour this, and it is the one answer a project has to a
     * devDependency Nimbus cannot run — a headless-browser driver, a native
     * toolchain — when the thing being installed is the runtime, not the test
     * suite. The flag was in the arg spec but its value was dropped, so it
     * silently did nothing and the install failed on a package the caller had
     * already said to skip.
     */
    production: boolean;
}
export declare function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation;
//# sourceMappingURL=install-args.d.ts.map