import type { VFS } from '../kernel/vfs/index.js';
export declare class HistoryManager {
    private entries;
    private vfs;
    constructor(vfs: VFS);
    load(): void;
    save(): void;
    add(line: string): void;
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