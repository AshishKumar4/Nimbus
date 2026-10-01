import type { Command } from './types.js';
/**
 * Where a command name is being resolved from. A name that is a path (./x,
 * ../x) or one found under the caller's node_modules/.bin depends on the
 * calling shell's cwd, and the registry is shared by every shell of a
 * workspace: the session's, each named shell, each exec.
 */
export interface ResolveContext {
    cwd: string;
}
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