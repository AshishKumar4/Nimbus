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

/**
 * djb2 over a string's UTF-16 code units or over bytes, as an unsigned
 * 32-bit integer: fast, deterministic, not cryptographic. The one hash
 * behind loader cache keys and peer placement.
 */
export function djb2(input: string | Uint8Array): number {
  let hash = 5381;
  if (typeof input === 'string') {
    for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  } else {
    for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input[i]) | 0;
  }
  return hash >>> 0;
}

/** {@link djb2} of `source` in base 36, for loader cache keys. */
export function hashSource(source: string): string {
  return djb2(source).toString(36);
}
