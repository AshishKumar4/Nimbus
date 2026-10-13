/**
 * runtime-store.ts — where `nimbus install` puts a runtime, as apt does on
 * Linux: its tree in `/usr/lib/nimbus/<name>/<version>`, owned by root, and
 * a launcher for each of its commands in `/usr/bin`, a link into the tree.
 *
 * The store is the kernel's, so it is reached through no directory anyone
 * else may replace: `/usr` is in root's `/`, and each directory from it
 * down is checked to be root's own real directory, writable by no one else,
 * before the kernel writes there. One a session's user owns, or a link (only
 * root could have made either), refuses the install rather than be written
 * through. Releases through core 0.19 kept runtimes below `~/.nimbus/runtimes`;
 * a workspace moves them here once, as it opens (moveHomeRuntimes).
 */
import type { CredentialedVfs as EngineVfs } from '../vfs/sqlite-vfs.js';
import type { RuntimeManifest } from './runtime-manifest.js';
/** Where installed runtimes live: `<store>/<name>/<version>`. */
export declare const RUNTIME_STORE = "usr/lib/nimbus";
/** Where a runtime's commands get their launchers. */
export declare const LAUNCHER_DIR = "usr/bin";
/** What the store asks of the filesystem it is written through: the installer's own view. */
export interface RuntimeStoreFs {
    stat(path: string, options?: {
        follow?: boolean;
    }): Promise<{
        type: string;
        uid?: number;
        mode?: number;
    } | null>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    unlink(path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
}
/** Whether `entry` (looked at without following it) is a directory only root may change. */
export declare function rootsOwn(entry: {
    type: string;
    uid?: number;
    mode?: number;
} | null): boolean;
/** The directories from `/` to the store: each must be root's own (rootsOwn) for the store to be read or written. */
export declare const RUNTIME_STORE_DIRS: readonly string[];
/**
 * Make the store ready to write: each directory from `/usr` down made by
 * root if it is missing, and refused unless it is root's own real directory
 * that no one else may write.
 */
export declare function prepareRuntimeStore(fs: RuntimeStoreFs): Promise<void>;
/** A runtime command's launcher in `/usr/bin`. */
export interface RuntimeLauncher {
    /** The command it launches, as its entrypoint names it. */
    binName: string;
    /** The name it runs by path, as the registry knows it: `/usr/bin/<command>`. */
    command: string;
    /** The launcher, as a key: `usr/bin/<command>`. */
    path: string;
    /** What it links to: the tree's own `bin/<command>`. */
    target: string;
}
/** A runtime's launchers: `/usr/bin/<command>` for each of `commands` its tree has a `bin/<command>` for. */
export declare function runtimeLaunchers(manifest: RuntimeManifest, root: string, commands: Iterable<string>): RuntimeLauncher[];
/**
 * Point each launcher at its tree, and answer the ones that lead there: a
 * launcher of ours that leads to another version is replaced; anything else
 * at that name (a file or link someone put there with sudo) is left, and the
 * command runs by name only. The tree's `bin/<command>` is a marker the
 * shell's registry runs by its path, not a program: one left executable (as
 * an earlier tree may be) is made not to be, so a guest Bash that finds it
 * is refused it rather than running its comments as an empty script. The
 * tree is the store's, reached through root's own directories only
 * (listInstalledManifestsView, prepareRuntimeStore).
 */
export declare function linkLaunchers(fs: RuntimeStoreFs, launchers: readonly RuntimeLauncher[]): Promise<RuntimeLauncher[]>;
/** Remove each launcher that leads into its tree, and answer the ones removed. */
export declare function unlinkLaunchers(fs: RuntimeStoreFs, launchers: readonly RuntimeLauncher[]): Promise<RuntimeLauncher[]>;
/**
 * Move the runtimes an earlier release installed below `<home>/.nimbus/runtimes`
 * into the store, as the kernel, once, and leave a link at the old path so
 * what names it (a durable launch's recipe, a script) still finds them. One
 * synchronous turn on the session's own filesystem, so nothing changes
 * between a look and a move; each name is looked at without following it,
 * and only root's own real directories move. A version already in the store
 * stays where it was; then the link is not made. What moved is verified by
 * its payload digests when it is bound (rehydration), not here.
 */
export declare function moveHomeRuntimes(kernel: EngineVfs, home: string): string[];
//# sourceMappingURL=runtime-store.d.ts.map