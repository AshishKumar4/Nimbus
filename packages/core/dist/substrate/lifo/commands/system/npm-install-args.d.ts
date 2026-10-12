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
    /**
     * `-D` / `--save-dev`: record the spec under devDependencies. Read by the
     * in-process install path, which owns the package.json update itself.
     */
    saveDev: boolean;
    /** `-O` / `--save-optional`: record the spec under optionalDependencies. */
    saveOptional: boolean;
    /** `-f` / `--force`: a peer conflict the project owns is a warning, not ERESOLVE. */
    force: boolean;
    /** `--legacy-peer-deps`: peers are neither installed nor checked, as npm 6 did. */
    legacyPeerDeps: boolean;
    /** `--omit=optional` (or `--no-optional`): what only optional dependencies need is not installed. */
    omitOptional: boolean;
    /** `--omit=peer`: what only peer dependencies need is not installed. */
    omitPeer: boolean;
    /** `--prefer-dedupe`: an installed copy is replaced by an older one that meets every edge too, so one copy serves them all. */
    preferDedupe: boolean;
    /** False for `--no-save`: package.json is left as it is. */
    save: boolean;
    /** What a saved range starts with: `--save-prefix`, '' for `--save-exact`, else '^'. */
    savePrefix: string;
    /** Options npm has that this npm does not implement, as npm ERR! lines: the install refuses them rather than ignore them. */
    unsupported: string[];
}
export declare function parseNpmInstallInvocation(args: string[]): NpmInstallInvocation;
//# sourceMappingURL=npm-install-args.d.ts.map