import type { Command, CommandOutputStream } from '../types.js';
type SedVfs = {
    stat(path: string): object;
    readFileString(path: string): string;
    writeFile(path: string, content: string | Uint8Array): void;
};
type SedInput = {
    readAll(): Promise<string>;
};
export type SedExecutionContext = {
    args: string[];
    cwd: string;
    vfs: SedVfs;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    stdin?: SedInput;
};
export declare function runSed(ctx: SedExecutionContext): Promise<number>;
declare const command: Command;
export default command;
//# sourceMappingURL=sed.d.ts.map