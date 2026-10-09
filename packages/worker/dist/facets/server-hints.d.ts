/**
 * server-hints.ts — which programs start as residents directly. Hints only:
 * a program that listens runs on as a resident however it started
 * (FacetManager._promote), so a hint that is missing or wrong costs time,
 * never correctness. A server it names skips the run up to its listen that
 * its first launch would otherwise make twice.
 *
 *   KNOWN_SERVER_BINS_HINT   bins that serve unless told to do something that
 *                            ends (`build`, `--version`): vite, next, astro…
 *   learned                  a program that listened, by its package, bin and
 *                            first positional argument, learned in this
 *                            workspace when it was run on as a resident.
 */
import type { ServerIdentity } from '@nimbus-sh/core/runtime/server-launch.js';
export declare function serverIdentityKey(identity: ServerIdentity): string;
/** The first argument that is not an option: the subcommand, when the bin has one. */
export declare function firstPositional(argv: readonly string[]): string;
export declare const KNOWN_SERVER_BINS_HINT: ReadonlySet<string>;
/** An argument that asks a CLI for help or its version: it prints and ends. */
export declare function isNonInteractiveArg(arg: string): boolean;
/**
 * Whether `binName argv` is a known server's serving invocation: one of the
 * known bins, unless asked for help, its version or a `build` (each ends);
 * any bin watching or serving by flag.
 */
export declare function knownServerBin(binName: string, argv: readonly string[]): boolean;
/** The storage a workspace's learned hints are kept in (its session's). */
export interface ServerHintStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}
/** Identities kept, the least recently learned leaving first. */
export declare const LEARNED_SERVERS_MAX = 256;
/** The programs this workspace learned are servers, read once per isolate. */
export declare class LearnedServers {
    private readonly storage;
    private keys;
    constructor(storage: ServerHintStorage);
    private load;
    has(identity: ServerIdentity): Promise<boolean>;
    learn(identity: ServerIdentity): Promise<void>;
}
//# sourceMappingURL=server-hints.d.ts.map