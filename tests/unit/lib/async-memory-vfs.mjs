// Remote-mount fixtures use the core filesystem; this adapter owns only the
// asynchronous face and deliberately exposes no synchronous backend.
import { MemoryVFS } from '../../../packages/core/src/vfs/memory.ts';

export function asyncMemoryVfs() {
  return asyncOnly(new MemoryVFS({ uid: 1000, gid: 1000 }), { deep: true });
}

/**
 * Hide the synchronous face. `deep` defers every call, including principal
 * views returned by as(), to a later microtask like an asynchronous backend.
 * @param {object} vfs
 * @param {{deep?: boolean, beforeCall?: (method: string, args: any[]) => any, hide?: string[], methods?: Record<string, Function>}} [options]
 */
export function asyncOnly(vfs, { deep = false, beforeCall, hide = [], methods = {} } = {}) {
  const options = { deep, beforeCall, hide, methods };
  return new Proxy(vfs, {
    get(target, key) {
      if (key === 'sync' || typeof key === 'string' && hide.includes(key)) return undefined;
      const value = typeof key === 'string' && Object.hasOwn(methods, key) ? methods[key] : target[key];
      if (typeof value !== 'function') return value;
      if (key === 'as') return (...args) => asyncOnly(value.apply(target, args), options);
      if (!deep && !beforeCall) return value.bind(target);
      return (...args) => Promise.resolve().then(async () => {
        await beforeCall?.(String(key), args);
        return value.apply(target, args);
      });
    },
    has: (target, key) => key !== 'sync' && !(typeof key === 'string' && hide.includes(key)) && key in target,
  });
}
