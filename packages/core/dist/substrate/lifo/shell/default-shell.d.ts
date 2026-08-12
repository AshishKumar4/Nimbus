import type { Command } from '../commands/types.js';
import type { VFS } from '../kernel/vfs/index.js';
export type DefaultShell = 'lifo' | 'bash';
export declare function defaultShellPath(home: string): string;
export declare function readDefaultShell(vfs: Pick<VFS, 'readFileString'>, home: string): DefaultShell;
export declare function makeChshCommand(deps: {
    isBashInstalled(home: string): boolean;
}): Command;
//# sourceMappingURL=default-shell.d.ts.map