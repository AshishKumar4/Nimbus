import { SerializationError } from './errors.js';

export function serializeFunction(fn: Function): string {
  if (typeof fn !== 'function') {
    throw new SerializationError(
      `Expected a function, got ${typeof fn}`,
    );
  }

  const source = fn.toString();

  if (source.includes('[native code]')) {
    throw new SerializationError(
      `Cannot serialize native function: ${fn.name || '(anonymous)'}. ` +
        'Only user-defined functions can be dispatched to remote isolates.',
    );
  }

  // `this` has no receiver in the remote isolate — reject it early.
  if (/\bthis\b/.test(source)) {
    throw new SerializationError(
      `Function "${fn.name || '(anonymous)'}" references \`this\`, which is ` +
        'not available in a remote isolate. Pass values as explicit arguments instead.',
    );
  }

  return source;
}

// djb2 hash — fast, deterministic, not cryptographic. Used only for loader cache key differentiation.
export function hashSource(source: string): string {
  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
