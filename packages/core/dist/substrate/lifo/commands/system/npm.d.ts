import type { Command, CommandContext } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import type { Kernel } from '../../kernel/index.js';
import { type NpmCacheMode } from '../../../../_shared/npm-cache-mode.js';
import { type NpmLogEmitter } from './npm-log.js';
import { type EngineMismatch } from '../../../../_shared/npm-arborist/engines.js';
/** The registry an install reads from when its env names none. */
export declare const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
export interface PackageJson {
    name?: string;
    version?: string;
    description?: string;
    main?: string;
    bin?: string | Record<string, string>;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    license?: string;
    author?: string | {
        name: string;
    };
}
/** A script of package.json npm runs: its event (test, pretest, …), its text, and the words npm appends to it. */
export interface NpmScript {
    event: string;
    script: string;
    args: readonly string[];
}
/** The host's shell, running `cmd` for the command `ctx`; for npm run, the script it is. */
export type ShellExecuteFn = (cmd: string, ctx: CommandContext, script?: NpmScript) => Promise<number>;
/**
 * What `npm install` asks of an install, as the command parsed it. The
 * host's port hands it to its installer whole (its NpmInstallOptions are
 * this, less what the port settles itself), so an option the command
 * gains reaches the installer without the port naming it.
 */
export interface NpmInstallSpec {
    projectDir: string;
    packages: readonly string[];
    global: boolean;
    /** Resolved absolute prefix — present only when `global` is set. */
    globalPrefix?: string;
    /** The running command's pid — authorizes the host's batch writes. */
    pid: number;
    /** `--save-dev`: what is named is saved to devDependencies. */
    saveDev?: boolean;
    /** `--save-optional`: what is named is saved to optionalDependencies. */
    saveOptional?: boolean;
    /** `--force`: a peer conflict the project owns is a warning, not ERESOLVE, and node's engine is not checked. */
    force?: boolean;
    /** `--engine-strict`: a package whose engines exclude this node or npm fails the install, which changes nothing. */
    engineStrict?: boolean;
    /** `--strict-peer-deps`: any peer conflict is ERESOLVE unless forced. */
    strictPeerDeps?: boolean;
    /** `--legacy-peer-deps`: peers are not installed, nor checked. */
    legacyPeerDeps?: boolean;
    /** `--omit=optional` / `--omit=peer`: what only optional or only peer dependencies need is planned, and not installed. */
    omitOptional?: boolean;
    omitPeer?: boolean;
    /** `--prefer-dedupe`: one copy serves every edge it can, an older one included. */
    preferDedupe?: boolean;
    /** False for `--no-save`: package.json is left as it is. */
    save?: boolean;
    /** What a saved range starts with ('' for `--save-exact`); '^' when not given. */
    savePrefix?: string;
    /** The command's: an install it stops before publication changes nothing, and one waiting for the tree never starts. */
    signal?: AbortSignal;
    /** Registry origin from the command's env (`NPM_REGISTRY`), else the default. */
    registry: string;
    /** How packuments and tarballs are read (npm's cache mode: `--offline`, `--prefer-offline`, `--prefer-online`); 'default' when not given. */
    cache?: NpmCacheMode;
    /** `--omit=dev` (`--production`): what only devDependencies reach is planned, not installed. */
    production?: boolean;
    /** `npm ci`: build npm's tree over package-lock.json, fail unless it is the lock's, then remove node_modules and install it. */
    fromLockfile?: boolean;
    npmLog?: NpmLogEmitter | null;
    onProgress?: (line: string) => void;
}
/**
 * The host's piece of `npm install`: once the invocation has been parsed
 * into a spec and the summary output decided, the install itself is
 * whatever the host's batched installer does. Global installs carry the
 * resolved prefix so the host — not this command — owns where
 * `<prefix>/lib/node_modules` and `<prefix>/bin` land.
 */
export interface NpmInstallPort {
    install(spec: NpmInstallSpec): Promise<{
        installed: string[];
        failed: string[];
        totalFiles?: number;
        fromCacheHits?: number;
        linkedBins?: number;
        engines?: readonly EngineMismatch[];
    }>;
    /**
     * The host's records of the bins of `packages`, which `npm uninstall`
     * removed from `modulesDir`: retired, shims and all, so no later install
     * links them again. `globalBinDir`: a global uninstall's, the prefix's bin
     * directory, where the host put them on PATH. `pid` authorizes the writes.
     */
    unlinkBins?(spec: {
        modulesDir: string;
        globalBinDir?: string;
        pid: number;
        packages: readonly string[];
    }): Promise<void>;
    /**
     * The hold the host's installs take on the tree at `modulesDir` (core
     * npm-tree.ts holdTree), for a command that changes it otherwise (`npm
     * uninstall`): one change to a tree at a time. Answers its release; one
     * that `signal` stops while it waits never holds it. A host with none
     * shares the shell's own installs' hold.
     */
    hold?(spec: {
        modulesDir: string;
        pid: number;
        signal: AbortSignal;
    }): Promise<() => void>;
}
export interface NpmCommandDeps {
    installer?: NpmInstallPort;
    /**
     * The host's, before the command replaces a file of the project
     * (package.json): one an earlier release of the host wrote as root is
     * handed to its directory's owner, so the command, as its process, can.
     */
    beforeWrite?: (ctx: CommandContext, path: string) => Promise<void>;
    /**
     * The host's word before npm run runs `run` (pre and post scripts with
     * it), the project's package.json `manifest`: an exit code to stop with,
     * or null to run it.
     */
    beforeRun?: (ctx: CommandContext, run: NpmScript & {
        manifest: Readonly<PackageJson>;
    }) => Promise<number | null>;
}
/**
 * The registry origin an install uses: the command's `NPM_REGISTRY`, else
 * the default. Normalized once, here, where the setting is read: blank is
 * unset, and a trailing slash is trimmed so one origin spelled two ways
 * shares one cache namespace downstream.
 */
export declare function npmRegistryOrigin(configured: string | undefined): string;
/** A package's bins, name -> target inside the package, as npm installs them (npmBinMap). */
/**
 * The packages in a node_modules directory, by name (`pkg` or `@scope/pkg`):
 * each entry that is a directory or a link (an `npm link`ed or workspace
 * package), a scope's entries in its place. Names starting with `.` (`.bin`,
 * `.package-lock.json`) are npm's own files, not packages; a directory that
 * cannot be read holds none.
 */
export declare function packagesIn(vfs: VFS, modulesDir: string): AsyncGenerator<string>;
export declare function getBinEntries(pkg: PackageJson): Record<string, string>;
export declare function registerBinCommand(registry: CommandRegistry, binName: string, scriptPath: string, kernel?: Kernel): void;
export declare function createNpmCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel, deps?: NpmCommandDeps): Command;
/**
 * Install one package globally, through the install port (the host's, else
 * the shell's own). Called directly by `lifo install` to avoid the
 * shell.execute() round-trip, which can silently swallow output and errors.
 */
export declare function npmInstallGlobal(packageName: string, ctx: CommandContext, registry: CommandRegistry, kernel?: Kernel, deps?: NpmCommandDeps): Promise<number>;
//# sourceMappingURL=npm.d.ts.map