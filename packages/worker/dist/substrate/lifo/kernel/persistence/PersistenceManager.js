import { serialize, deserialize } from './serializer.js';
const DEBOUNCE_MS = 1000;
export class PersistenceManager {
    backend;
    timer = null;
    constructor(backend) {
        this.backend = backend;
    }
    async open() {
        await this.backend.open();
    }
    async load() {
        try {
            const data = await this.backend.loadTree();
            if (data) {
                try {
                    return deserialize(data);
                }
                catch {
                    return null;
                }
            }
            return null;
        }
        catch {
            return null;
        }
    }
    async save(root) {
        try {
            const data = serialize(root);
            await this.backend.saveTree(data);
        }
        catch {
            // Gracefully ignore save errors
        }
    }
    scheduleSave(root) {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.save(root).catch(() => { });
            this.timer = null;
        }, DEBOUNCE_MS);
    }
}
