import type { Command, CommandInputStream, CommandOutputStream } from '../types.js';
type SedVfs = {
    stat(path: string): unknown;
    readFile(path: string): Uint8Array | Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): void | Promise<void>;
};
export type SedExecutionContext = {
    args: string[];
    cwd: string;
    vfs: SedVfs;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    stdin?: string | CommandInputStream;
};
export declare function runSed(ctx: SedExecutionContext): Promise<number>;
declare const command: Command;
export default command;
//# sourceMappingURL=sed.d.ts.map