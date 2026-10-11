// A Durable Object's async key-value storage, in memory (get, put, delete,
// list by prefix), as a clone's job records use it (git/clone-job.ts).
export function memoryStorage() {
  const stored = new Map();
  return {
    stored,
    async get(key) { return structuredClone(stored.get(key)); },
    async put(key, value) { stored.set(key, structuredClone(value)); },
    async delete(key) { return stored.delete(key); },
    async list({ prefix }) {
      return new Map([...stored].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
    },
  };
}
