// The realm's four Function constructors (Function, AsyncFunction,
// GeneratorFunction, AsyncGeneratorFunction), hooked for a differential run
// (capture-preload.mjs, shadow-preload.mjs). Each call's arguments are
// converted to strings once, as the constructor converts them (a template
// literal's ToString, which refuses a Symbol as Function does), and those
// strings are what the native constructor builds from and what the hook
// sees: a body whose toString answers differently each time cannot give the
// two sides different code.

export const FUNCTION_KINDS = [
  ['function', Function],
  ['async', Object.getPrototypeOf(async function () {}).constructor],
  ['generator', Object.getPrototypeOf(function* () {}).constructor],
  ['asyncGenerator', Object.getPrototypeOf(async function* () {}).constructor],
];

/**
 * Replace each constructor (as its prototype's `constructor`, and
 * globalThis.Function) with one that builds the native function and returns
 * `hook({ kind, params, body, native })`. The replacement keeps the native
 * constructor's name, length, prototype and [[Prototype]], and a call with
 * `new` builds as `new` would.
 */
export function hookFunctionConstructors(hook) {
  for (const [kind, Native] of FUNCTION_KINDS) {
    const hooked = function (...args) {
      const strings = args.map((arg) => `${arg}`);
      const native = new.target === undefined ? Reflect.apply(Native, undefined, strings) : Reflect.construct(Native, strings, new.target);
      return hook({ kind, params: strings.slice(0, -1), body: strings.length ? strings[strings.length - 1] : '', native });
    };
    Object.defineProperty(hooked, 'name', { value: Native.name });
    Object.defineProperty(hooked, 'length', { value: Native.length });
    Object.defineProperty(hooked, 'prototype', { value: Native.prototype, writable: false });
    Object.setPrototypeOf(hooked, Object.getPrototypeOf(Native));
    Object.defineProperty(Native.prototype, 'constructor', { value: hooked, writable: true, configurable: true, enumerable: false });
    if (kind === 'function') globalThis.Function = hooked;
  }
}
