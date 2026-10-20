import type { ProcessView } from '../../../runtime/process-files.js';
export declare class HistoryManager {
    private readonly filesystem;
    private readonly file;
    private entries;
    private loaded;
    /** `file`: where the history is kept (bash's HISTFILE). */
    constructor(filesystem: () => ProcessView, file: () => string);
    load(): Promise<void>;
    private readHistory;
    save(): Promise<void>;
    add(line: string): Promise<void>;
    /**
     * Expand history references:
     * !! -> last command
     * !n -> nth command (1-based)
     * !-n -> nth from end
     * !prefix -> most recent command starting with prefix
     * Returns null if no expansion needed.
     */
    expand(line: string): string | null;
    get(index: number): string | undefined;
    /** Every entry, oldest first; the store's own array, for reading. */
    getAll(): readonly string[];
    get length(): number;
}
//# sourceMappingURL=history.d.ts.map