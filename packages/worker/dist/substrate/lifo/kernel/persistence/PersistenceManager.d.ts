import type { INode } from '../vfs/types.js';
import type { PersistenceBackend } from './backends.js';
export declare class PersistenceManager {
    private backend;
    private timer;
    constructor(backend: PersistenceBackend);
    open(): Promise<void>;
    load(): Promise<INode | null>;
    save(root: INode): Promise<void>;
    scheduleSave(root: INode): void;
}
//# sourceMappingURL=PersistenceManager.d.ts.map