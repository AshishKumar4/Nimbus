import type { ExecutionFs } from "../../../shell/execution-fs.js";
export declare class HistoryManager {
    private readonly filesystem;
    private readonly home;
    private entries;
    private loaded;
    constructor(filesystem: () => ExecutionFs, home: () => string);
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
    getAll(): string[];
    get length(): number;
}
//# sourceMappingURL=history.d.ts.map