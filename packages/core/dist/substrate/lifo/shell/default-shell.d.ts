import type { Command } from '../commands/types.js';
import type { ProcessView } from '../../../runtime/process-files.js';
export type DefaultShell = 'lifo' | 'bash';
export declare function defaultShellPath(home: string): string;
export declare function readDefaultShell(vfs: Pick<ProcessView, 'readFileString'>, home: string): Promise<DefaultShell>;
export declare function makeChshCommand(deps: {
    isBashInstalled(home: string): boolean | Promise<boolean>;
}): Command;
//# sourceMappingURL=default-shell.d.ts.map