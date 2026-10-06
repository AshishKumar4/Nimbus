import type { Command, CommandContext } from '../types.js';
/** How gzip and gunzip treat each FILE. */
export interface GzipFileOptions {
    /** The program name its messages carry. */
    readonly name: string;
    readonly decompress: boolean;
    readonly keep: boolean;
    readonly force: boolean;
    readonly quiet: boolean;
}
/**
 * Compress each file to FILE.gz, or decompress each FILE.gz to FILE, as GNU
 * gzip 1.14 does: the input goes unless -k; an existing output is not
 * overwritten without -f (a warning, even under -q); a name without the
 * .gz suffix is skipped with a warning, which -q silences. Exit status: 1
 * for an error, else 2 for a warning, else 0.
 */
export declare function gzipFiles(ctx: CommandContext, files: readonly string[], options: GzipFileOptions): Promise<number>;
declare const command: Command;
export default command;
//# sourceMappingURL=gzip.d.ts.map