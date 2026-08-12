import type { VFS } from '../kernel/vfs/index.js';
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
    vfs: VFS;
    registry: CommandRegistry;
    builtinNames: string[];
}
export declare function complete(ctx: CompletionContext): CompletionResult;
//# sourceMappingURL=completer.d.ts.map