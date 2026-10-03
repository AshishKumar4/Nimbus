import type { Command } from './types.js';
import type { ProcessView } from '../../../runtime/process-files.js';
/**
 * Where a command name is being resolved from. The registry is shared by
 * every shell of a workspace (the session's, each named shell, each exec),
 * and a name may depend on the caller: a path (./x, ../x) or one under its
 * node_modules/.bin on its cwd, and a bare name not registered here on the
 * PATH of the environment it is invoked from, searched as execvp searches
 * it, as the caller.
 */
export interface ResolveContext {
    cwd: string;
    /** The invoking environment's PATH. */
    path: string;
    /**
     * The namespace as the caller sees it, under its credential: a name is
     * found, inspected and authorized here, as the caller will run it. (The
     * credential decides the namespace too, as a confined principal's /tmp.)
     */
    view: ProcessView;
    /**
     * Whether a bare name nothing registers may be searched for, on PATH and
     * in the cwd's node_modules/.bin. False answers registered names alone
     * (with the runtimes the workspace can install), as an absolute #!
     * interpreter's name, or `which`'s builtin check, asks.
     */
    search: boolean;
}
/**
 * The context a caller resolves from: its directory, its environment's
 * PATH, and its view. One without an environment, or whose environment has
 * no PATH, searches the session's default PATH.
 */
export declare function resolveContext(cwd: string, env: Readonly<Record<string, string>> | undefined, view: ProcessView): ResolveContext;
export declare class CommandRegistry {
    private commands;
    private lazy;
    register(name: string, command: Command): void;
    registerLazy(name: string, loader: () => Promise<{
        default: Command;
    }>): void;
    unregister(name: string): void;
    /** `from`: the calling shell, for resolvers installed over this one (exec-dispatch, npm bins). */
    resolve(name: string, _from?: ResolveContext): Promise<Command | undefined>;
    has(name: string): boolean;
    list(): string[];
}
export declare function createDefaultRegistry(): CommandRegistry;
//# sourceMappingURL=registry.d.ts.map