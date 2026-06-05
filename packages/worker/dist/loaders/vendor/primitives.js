import { SerializationError } from './errors.js';
export function pure(fn) {
    if (typeof fn !== 'function') {
        throw new SerializationError(`pure() expected a function, got ${typeof fn}`);
    }
    const source = fn.toString();
    if (source.includes('[native code]')) {
        throw new SerializationError(`pure(): cannot brand native function "${fn.name || '(anonymous)'}"`);
    }
    if (/\bthis\b/.test(source)) {
        throw new SerializationError(`pure(): function "${fn.name || '(anonymous)'}" references \`this\`, ` +
            'which is not available in a remote isolate. Remove `this` usage or ' +
            'pass the value as an explicit argument.');
    }
    const branded = fn;
    Object.defineProperty(branded, '__pure', {
        value: true,
        writable: false,
        enumerable: false,
        configurable: false,
    });
    return branded;
}
export function isPure(fn) {
    return fn.__pure === true;
}
/**
 * Identity function that signals a value is intended as a serializable
 * constant for remote execution. No-op at runtime.
 */
export function constant(value) {
    return value;
}
