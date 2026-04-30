import { SerializationError } from './errors.js';

export type Pure<F> = F & { readonly __pure: true };

export function pure<F extends Function>(fn: F): Pure<F> {
  if (typeof fn !== 'function') {
    throw new SerializationError(
      `pure() expected a function, got ${typeof fn}`,
    );
  }

  const source = fn.toString();

  if (source.includes('[native code]')) {
    throw new SerializationError(
      `pure(): cannot brand native function "${fn.name || '(anonymous)'}"`,
    );
  }

  if (/\bthis\b/.test(source)) {
    throw new SerializationError(
      `pure(): function "${fn.name || '(anonymous)'}" references \`this\`, ` +
        'which is not available in a remote isolate. Remove `this` usage or ' +
        'pass the value as an explicit argument.',
    );
  }

  const branded = fn as Pure<F>;
  Object.defineProperty(branded, '__pure', {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return branded;
}

export function isPure(fn: Function): fn is Pure<typeof fn> {
  return (fn as any).__pure === true;
}

/**
 * Identity function that signals a value is intended as a serializable
 * constant for remote execution. No-op at runtime.
 */
export function constant<T>(value: T): T {
  return value;
}
