// ---------------------------------------------------------------------------
// MemoryPersistenceBackend
// ---------------------------------------------------------------------------
export class MemoryPersistenceBackend {
    tree = null;
    async open() {
        // Nothing to initialize for in-memory storage.
    }
    async loadTree() {
        return this.tree;
    }
    async saveTree(root) {
        this.tree = root;
    }
    async close() {
        this.tree = null;
    }
}
