import type { ExecutionFs } from "../../../shell/execution-fs.js";
import type { CommandRegistry } from '../commands/registry.js';
export interface CompletionResult {
    replacementStart: number;
    replacementEnd: number;
    completions: string[];
    commonPrefix: string;
}
export interface CompletionContext {
    line: string;
    cursorPos: number;
    cwd: string;
    env: Record<string, string>;
    vfs: ExecutionFs;
    registry: CommandRegistry;
    builtinNames: string[];
}
export declare function complete(ctx: CompletionContext): Promise<CompletionResult>;
//# sourceMappingURL=completer.d.ts.map