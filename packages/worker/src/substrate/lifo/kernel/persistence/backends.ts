import type { SerializedNode } from './serializer.js';

// ---------------------------------------------------------------------------
// PersistenceBackend interface
// ---------------------------------------------------------------------------

export interface PersistenceBackend {
  open(): Promise<void>;
  loadTree(): Promise<SerializedNode | null>;
  saveTree(root: SerializedNode): Promise<void>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemoryPersistenceBackend
// ---------------------------------------------------------------------------

export class MemoryPersistenceBackend implements PersistenceBackend {
  private tree: SerializedNode | null = null;

  async open(): Promise<void> {
    // Nothing to initialize for in-memory storage.
  }

  async loadTree(): Promise<SerializedNode | null> {
    return this.tree;
  }

  async saveTree(root: SerializedNode): Promise<void> {
    this.tree = root;
  }

  async close(): Promise<void> {
    this.tree = null;
  }
}
