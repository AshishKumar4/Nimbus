/**
 * npm-install-args.ts — what `npm install` and `npm ci` take from npm's
 * configuration (npm-config.ts: the command line as npm's nopt parses it,
 * npm_config_* and the .npmrc files), the one place npm's options are read.
 */
import type { NpmConfig } from './npm-config.js';
import { type NpmLogLevel } from './npm-log.js';
import { type NpmCacheMode } from '../../../../_shared/npm-cache-mode.js';
export interface NpmInstallInvocation {
    packages: string[];
    global: boolean;
    prefix: string | null;
    /** `--loglevel`, when it names a level npm recognises; null otherwise. */
    loglevel: NpmLogLevel | null;
    /**
     * `--omit=dev` (or npm's deprecated `--production`, bun's `-p`): install dependencies only.
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
    /** `--strict-peer-deps`: any peer conflict is ERESOLVE unless forced, not only the project's. */
    strictPeerDeps: boolean;
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
    /** `--engine-strict`: a package whose engines exclude this node or npm fails the install (EBADENGINE), where npm otherwise warns. */
    engineStrict: boolean;
    /** The registry npm's configuration names (`--registry`, npm_config_registry, an .npmrc); null where only npm's default does. */
    registry: string | null;
    /** How the install's packuments are read: npm's cache mode (npm-cache-mode.ts) from its configuration. */
    cache: NpmCacheMode;
    /** Options npm has that this npm does not implement, as npm ERR! lines: the install refuses them rather than ignore them. */
    unsupported: string[];
}
export declare function npmInstallInvocation(config: NpmConfig): NpmInstallInvocation;
//# sourceMappingURL=npm-install-args.d.ts.map