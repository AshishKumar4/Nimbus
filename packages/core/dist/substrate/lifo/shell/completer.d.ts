import type { ProcessView } from '../../../runtime/process-files.js';
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
    vfs: ProcessView;
    registry: CommandRegistry;
    builtinNames: string[];
}
export declare function complete(ctx: CompletionContext): Promise<CompletionResult>;
//# sourceMappingURL=completer.d.ts.map