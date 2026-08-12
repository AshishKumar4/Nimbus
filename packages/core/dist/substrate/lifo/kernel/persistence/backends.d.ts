import type { SerializedNode } from './serializer.js';
export interface PersistenceBackend {
    open(): Promise<void>;
    loadTree(): Promise<SerializedNode | null>;
    saveTree(root: SerializedNode): Promise<void>;
    close?(): Promise<void>;
}
export declare class MemoryPersistenceBackend implements PersistenceBackend {
    private tree;
    open(): Promise<void>;
    loadTree(): Promise<SerializedNode | null>;
    saveTree(root: SerializedNode): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=backends.d.ts.map