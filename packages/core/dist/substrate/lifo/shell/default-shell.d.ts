import type { Command } from '../commands/types.js';
import type { ExecutionFs } from "../../../shell/execution-fs.js";
export type DefaultShell = 'lifo' | 'bash';
export declare function defaultShellPath(home: string): string;
export declare function readDefaultShell(vfs: Pick<ExecutionFs, 'readFileString'>, home: string): Promise<DefaultShell>;
export declare function makeChshCommand(deps: {
    isBashInstalled(home: string): boolean | Promise<boolean>;
}): Command;
//# sourceMappingURL=default-shell.d.ts.map