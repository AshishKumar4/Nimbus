import type { Command, CommandInputStream } from '../types.js';
import type { ProcessView } from '../../../../runtime/process-files.js';
export interface GrepContext {
    args: string[];
    cwd: string;
    vfs: ProcessView;
    stdout: {
        write(text: string): unknown;
        writeBytes?(bytes: Uint8Array): unknown;
    };
    stderr: {
        write(text: string): unknown;
    };
    stdin?: string | CommandInputStream;
}
export declare function runGrep(ctx: GrepContext): Promise<number>;
declare const command: Command;
export default command;
//# sourceMappingURL=grep.d.ts.map