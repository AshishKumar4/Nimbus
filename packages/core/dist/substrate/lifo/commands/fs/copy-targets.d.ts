import type { CommandContext } from '../types.js';
/** Where cp's or mv's sources go: each source's target, from one look at the destination. */
export interface CopyTargets {
    readonly sources: readonly string[];
    /** The destination as the user named it, for messages. */
    readonly rawDest: string;
    readonly destIsDir: boolean;
    /** Where `src` (an absolute path) lands: inside the destination directory, else the destination. */
    targetFor(src: string): string;
}
/**
 * cp's and mv's operands, as GNU's read them: `-t DIR SOURCE...` or
 * `SOURCE... DEST`. -t, or more than one source, needs a directory, and
 * the refusal is GNU's ("target directory 'DIR': Not a directory", "target
 * 'DEST': No such file or directory"). A string is the message to print
 * after `NAME: `; null, a missing operand.
 */
export declare function resolveCopyTargets(ctx: CommandContext, positional: readonly string[], targetDirectory: string | null): Promise<CopyTargets | string | null>;
//# sourceMappingURL=copy-targets.d.ts.map