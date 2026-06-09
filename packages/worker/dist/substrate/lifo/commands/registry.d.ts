import type { Command } from './types.js';
export declare class CommandRegistry {
    private commands;
    private lazy;
    register(name: string, command: Command): void;
    registerLazy(name: string, loader: () => Promise<{
        default: Command;
    }>): void;
    unregister(name: string): void;
    resolve(name: string): Promise<Command | undefined>;
    has(name: string): boolean;
    list(): string[];
}
export declare function createDefaultRegistry(): CommandRegistry;
//# sourceMappingURL=registry.d.ts.map