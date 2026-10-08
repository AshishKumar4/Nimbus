/**
 * node-error.ts — Node's internal errors, as lib/internal/errors.js (v22.22.3)
 * makes them, for every error the runtime gives a code: the guest's shims and
 * module resolver, the shell's own Node compatibility, and the host code that
 * shares them. A NodeError reads `Name [CODE]: message` in its stack and its
 * toString(), carries its code as its own enumerable `code`, and is an
 * instance of its base class, whose name and constructor it reports; a
 * SystemError (`fs.rm` of a directory, `fs.cp` onto a file) adds the
 * system call's context.
 *
 * Self-contained: scripts/bundle-facet-workers.mjs compiles it into the
 * guest's shims (NODE_ERROR_PREAMBLE), which call it by name and hand it to
 * the cell runtime and generated code as `__nimbusNodeError` and
 * `__nimbusNodeSystemError`.
 */

type ErrorClass = new (message?: string) => Error;

/** One class per base and code, as Node makes one per code. */
const nodeErrorClasses = new Map<ErrorClass, Map<string, ErrorClass>>();
/** Each class's code, by its prototype. */
const classCodes = new WeakMap<object, string>();

/**
 * Node's error `code` on a `Base` (Error, TypeError, RangeError, …) with
 * `message`, and `props` set on it after (an `info`, a `cmd`). Its stack
 * starts at the caller of `above`: the frames above it are Node's own in Node.
 */
export function nodeError(Base: ErrorClass, code: string, message: string, props?: Record<string, unknown>, above: Function = nodeError): Error {
  return made(Base, code, message, props, above);
}

/** nodeError's error, its stack starting where `above` was called. */
function made(Base: ErrorClass, code: string, message: string, props: Record<string, unknown> | undefined, above: Function): Error {
  const NodeError = nodeErrorClass(Base, code);
  const error = new NodeError(message);
  headStack(error, `${error.name} [${code}]`, above);
  if (props !== undefined) Object.assign(error, props);
  return error;
}

/** Node's class for a code on a base (Error, TypeError, …), made once. */
function nodeErrorClass(Base: ErrorClass, code: string): ErrorClass {
  let classes = nodeErrorClasses.get(Base);
  if (classes === undefined) nodeErrorClasses.set(Base, (classes = new Map()));
  let NodeError = classes.get(code);
  if (NodeError === undefined) {
    NodeError = class extends Base {
      constructor(text?: string) {
        // The message reaches the constructor: workerd's V8 heads a stack
        // with the message an error was built with, not its property.
        super(text);
        Reflect.deleteProperty(this, 'message');
        // Own and enumerable, then the message, as Node's class field and constructor leave them.
        Object.defineProperty(this, 'code', { value: code, enumerable: true, writable: true, configurable: true });
        Object.defineProperty(this, 'message', { value: text, enumerable: false, writable: true, configurable: true });
      }

      toString(): string {
        return `${this.name} [${code}]: ${this.message}`;
      }
    };
    // What Node's NodeError reports as its constructor: its base.
    Object.defineProperty(NodeError.prototype, 'constructor', { get: () => Base, enumerable: false, configurable: true });
    classCodes.set(NodeError.prototype, code);
    classes.set(code, NodeError);
  }
  return NodeError;
}

/**
 * An error another implementation made for Node's `code` on `Base` (the
 * builtins workerd provides: their own `name` and `toString`, a stack headed
 * without the code), given in place the shape nodeError gives one: its
 * class, `code` then `message` its own properties, its stack headed
 * `Name [CODE]: message` over the frames it has. Its other own properties
 * stay. Returns it.
 */
export function reshapeAsNodeError(error: Error, Base: ErrorClass, code: string): Error {
  const message = error.message;
  let stack: unknown;
  try {
    stack = error.stack;
  } catch {
    stack = undefined;
  }
  const NodeError = nodeErrorClass(Base, code);
  const stackDescriptor = Object.getOwnPropertyDescriptor(error, 'stack');
  for (const key of ['stack', 'code', 'message', 'name', 'toString']) Reflect.deleteProperty(error, key);
  Object.setPrototypeOf(error, NodeError.prototype);
  if (stackDescriptor !== undefined) Object.defineProperty(error, 'stack', stackDescriptor);
  Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(error, 'message', { value: message, enumerable: false, writable: true, configurable: true });
  if (typeof stack === 'string') {
    const frames = stack.indexOf('\n    at ');
    const header = message === '' ? `${Base.name} [${code}]` : `${Base.name} [${code}]: ${message}`;
    Reflect.set(error, 'stack', header + (frames === -1 ? '' : stack.slice(frames)));
  }
  return error;
}

/** How a message shows a value only util.inspect can describe: the runtime's inspect once it is handed one. */
let inspectValue: (value: unknown, options: { depth?: number; colors?: boolean }) => string = (value) => String(value);

/** Hands the messages below the runtime's util.inspect (Node's lazyInternalUtilInspect). */
export function useNodeErrorInspect(inspect: typeof inspectValue): void {
  inspectValue = inspect;
}

/** The `expected` names ERR_INVALID_ARG_TYPE words as types (lib/internal/errors.js kTypes). */
const ARG_TYPES = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];
const CLASS_NAME = /^[A-Z][a-zA-Z0-9]*$/;

/** `A`, `A or B`, `A, B, or C` (lib/internal/errors.js formatList). */
function formatList(items: readonly string[], type: string): string {
  if (items.length < 3) return items.join(` ${type} `);
  return `${items.slice(0, -1).join(', ')}, ${type} ${items[items.length - 1]}`;
}

/** How Node's messages describe a value they were given (lib/internal/errors.js determineSpecificType). */
export function determineSpecificType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object': {
      const ctor: unknown = Reflect.get(value, 'constructor');
      if ((typeof ctor === 'function' || (typeof ctor === 'object' && ctor !== null)) && 'name' in ctor) {
        return `an instance of ${String(Reflect.get(ctor, 'name'))}`;
      }
      return inspectValue(value, { depth: -1 });
    }
    case 'string': {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return shown.includes("'") ? `type string (${JSON.stringify(shown)})` : `type string ('${shown}')`;
    }
    default: {
      let shown = inspectValue(value, { colors: false });
      if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
      return `type ${typeof value} (${shown})`;
    }
  }
}

/**
 * Node's ERR_INVALID_ARG_TYPE: `name` (an argument, a `a.b` property, or a
 * `first argument`) must be one of `expected` — types (`string`), classes
 * (`Buffer`) or anything else (`Array-like Object`) — and was `actual`.
 */
export function invalidArgType(name: string, expected: string | readonly string[], actual: unknown): Error {
  return made(TypeError, 'ERR_INVALID_ARG_TYPE', invalidArgTypeMessage(name, expected, actual), undefined, invalidArgType);
}

function invalidArgTypeMessage(name: string, expected: string | readonly string[], actual: unknown): string {
  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const value of typeof expected === 'string' ? [expected] : expected) {
    if (ARG_TYPES.includes(value)) types.push(value.toLowerCase());
    else if (CLASS_NAME.test(value)) instances.push(value);
    else other.push(value);
  }
  // `object` beside classes is worded as one of them.
  if (instances.length > 0 && types.includes('object')) {
    types.splice(types.indexOf('object'), 1);
    instances.push('Object');
  }
  let message = name.endsWith(' argument') ? `The ${name} must be ` : `The "${name}" ${name.includes('.') ? 'property' : 'argument'} must be `;
  if (types.length > 0) {
    message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) message += ' or ';
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) message += ' or ';
  }
  if (other.length > 1) message += `one of ${formatList(other, 'or')}`;
  else if (other.length === 1) message += `${other[0].toLowerCase() !== other[0] ? 'an ' : ''}${other[0]}`;
  return `${message}. Received ${determineSpecificType(actual)}`;
}

/** `1_000_000` (lib/internal/errors.js addNumericalSeparator). */
function addNumericalSeparator(value: string): string {
  let result = '';
  let i = value.length;
  const start = value[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${value.slice(i - 3, i)}${result}`;
  return `${value.slice(0, i)}${result}`;
}

/** util.format's `%s` of what Node's messages are handed. */
function formatNodeMessage(template: string, args: readonly unknown[]): string {
  let i = 0;
  return template.replace(/%s/g, () => {
    const value = args[i++];
    return typeof value === 'number' && Object.is(value, -0) ? '-0' : String(value);
  });
}

type Message = string | ((...args: never[]) => string);

/**
 * Node's message for each code lib/internal/errors.js defines (its E()) that
 * the runtime raises through `codes`, then the code's bases: its class's
 * first, the others named beside it (`codes.ERR_INVALID_ARG_VALUE.RangeError`).
 */
const nodeErrorMessages: Record<string, readonly [Message, ...ErrorClass[]]> = {
  ERR_AMBIGUOUS_ARGUMENT: ['The "%s" argument is ambiguous. %s', TypeError],
  ERR_CONSTRUCT_CALL_REQUIRED: ['Class constructor %s cannot be invoked without `new`', TypeError],
  ERR_INTERNAL_ASSERTION: [(message?: string) => {
    const suffix = 'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n'
      + 'Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n';
    return message === undefined ? suffix : `${message}\n${suffix}`;
  }, Error],
  ERR_INVALID_ARG_TYPE: [invalidArgTypeMessage, TypeError],
  ERR_INVALID_ARG_VALUE: [(name: string, value: unknown, reason = 'is invalid') => {
    let inspected = inspectValue(value, {});
    if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
    return `The ${name.includes('.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`;
  }, TypeError, RangeError],
  ERR_INVALID_RETURN_VALUE: [(input: string, name: string, value: unknown) =>
    `Expected ${input} to be returned from the "${name}" function but got ${determineSpecificType(value)}.`, TypeError, RangeError],
  ERR_INVALID_THIS: ['Value of "this" must be of type %s', TypeError],
  ERR_INVALID_URI: ['URI malformed', URIError],
  ERR_MISSING_ARGS: [(...names: (string | string[])[]) => {
    const wrapped = names.map((name) => (Array.isArray(name) ? name.map((n) => `"${n}"`).join(' or ') : `"${name}"`));
    return `The ${formatList(wrapped, 'and')} argument${names.length > 1 ? 's' : ''} must be specified`;
  }, TypeError],
  ERR_OUT_OF_RANGE: [(str: string, range: string, input: unknown, replaceDefaultBoolean = false) => {
    let received: string;
    if (Number.isInteger(input) && Math.abs(input as number) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === 'bigint') {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
      received += 'n';
    } else {
      received = inspectValue(input, {});
    }
    return `${replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`} It must be ${range}. Received ${received}`;
  }, RangeError],
  ERR_SOCKET_BAD_PORT: [(name: string, port: unknown, allowZero = true) =>
    `${name} should be ${allowZero ? '>=' : '>'} 0 and < 65536. Received ${determineSpecificType(port)}.`, RangeError],
  ERR_UNAVAILABLE_DURING_EXIT: ['Cannot call function in process exit handler', Error],
  ERR_UNKNOWN_SIGNAL: ['Unknown signal: %s', TypeError],
};

/** `new codes.ERR_X(...args)`: Node's error for the code, its stack from where it was made. */
export type NodeErrorConstructor = ((...args: never[]) => Error) & { [base: string]: NodeErrorConstructor };

function nodeErrorCodeConstructor(code: string, message: Message, Base: ErrorClass): NodeErrorConstructor {
  const make = function (...args: never[]): Error {
    const text = typeof message === 'string' ? formatNodeMessage(message, args) : Reflect.apply(message, undefined, args);
    return made(Base, code, text, undefined, make);
  } as NodeErrorConstructor;
  Object.defineProperty(make, 'name', { value: 'NodeError' });
  return make;
}

/**
 * lib/internal/errors.js `codes` for the codes in nodeErrorMessages: each a
 * constructor of its class, its other bases' beside it by name, and the
 * HideStackFramesError Node's validators construct (the same error here;
 * hideStackFrames moves its stack).
 */
export const nodeErrorCodes: Readonly<Record<string, NodeErrorConstructor>> = Object.fromEntries(Object.entries(nodeErrorMessages).map(([code, [message, Base, ...others]]) => {
  const constructor = nodeErrorCodeConstructor(code, message, Base);
  constructor.HideStackFramesError = constructor;
  for (const Other of others) {
    const other = nodeErrorCodeConstructor(code, message, Other);
    other.HideStackFramesError = other;
    constructor[Other.name] = other;
  }
  return [code, constructor];
}));

/**
 * lib/internal/errors.js hideStackFrames: `fn`, whose error's stack starts
 * where the wrapper was called; a Node error's stack keeps its code.
 */
export function hideStackFrames<F extends (...args: never[]) => unknown>(fn: F): F & { withoutStackTrace: F } {
  const wrapped = function (this: unknown, ...args: never[]): unknown {
    try {
      return Reflect.apply(fn, this, args);
    } catch (error) {
      if (Reflect.get(Error, 'stackTraceLimit') && error !== null && typeof error === 'object') {
        const code = classCodes.get(Object.getPrototypeOf(error) as object);
        if (code !== undefined) headStack(error as Error, `${(error as Error).name} [${code}]`, wrapped);
        else captureStack(error as Error, wrapped);
      }
      throw error;
    }
  } as F & { withoutStackTrace: F };
  wrapped.withoutStackTrace = fn;
  return wrapped;
}

/** lib/internal/errors.js isErrorStackTraceLimitWritable. */
export function isErrorStackTraceLimitWritable(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
  if (descriptor === undefined) return Object.isExtensible(Error);
  return Object.prototype.hasOwnProperty.call(descriptor, 'writable') ? descriptor.writable === true : descriptor.set !== undefined;
}

/** A system call's context, as Node's SystemError holds it (`info`), its keys in the order the call names them. */
export interface SystemErrorContext {
  code: string;
  message: string;
  syscall: string;
  errno: number;
  path?: string;
  dest?: string;
}

/** Node's SystemError class, made once. */
let SystemErrorClass: (new (code: string, message: string, context: SystemErrorContext) => Error) | undefined;

/**
 * Node's SystemError for `code` (its message `prefix`, as Node words it) and
 * a system call's `context`: `${prefix}: ${syscall} returned ${code}
 * (${message}) ${path} => ${dest}`, its `info` the context, and its errno,
 * syscall, path and dest that context's, read and written through. Node
 * inspects one with its getters' values.
 */
export function nodeSystemError(code: string, prefix: string, context: SystemErrorContext): Error {
  let message = `${prefix}: ${context.syscall} returned ${context.code} (${context.message})`;
  if (context.path !== undefined) message += ` ${context.path}`;
  if (context.dest !== undefined) message += ` => ${context.dest}`;
  SystemErrorClass ??= class SystemError extends Error {
    declare code: string;

    constructor(errorCode: string, text: string, info: SystemErrorContext) {
      // Built with its message, which heads its stack (NodeError above).
      super(text);
      Reflect.deleteProperty(this, 'message');
      this.code = errorCode;
      const through = (key: 'errno' | 'syscall' | 'path' | 'dest'): PropertyDescriptor => ({
        get: () => info[key],
        set: (value: never) => { info[key] = value; },
        enumerable: true,
        configurable: true,
      });
      Object.defineProperties(this, {
        name: { value: 'SystemError', enumerable: false, writable: true, configurable: true },
        message: { value: text, enumerable: false, writable: true, configurable: true },
        info: { value: info, enumerable: true, writable: false, configurable: true },
        errno: through('errno'),
        syscall: through('syscall'),
      });
      if (info.path !== undefined) Object.defineProperty(this, 'path', through('path'));
      if (info.dest !== undefined) Object.defineProperty(this, 'dest', through('dest'));
    }

    toString(): string {
      return `${this.name} [${this.code}]: ${this.message}`;
    }

    // util.inspect's third argument is inspect itself.
    [Symbol.for('nodejs.util.inspect.custom')](_depth: number, options: object, inspect: (value: unknown, options: object) => string): string {
      return inspect(this, { ...options, getters: true, customInspect: false });
    }
  };
  const error = new SystemErrorClass(code, message, context);
  headStack(error, `SystemError [${code}]`, nodeSystemError);
  return error;
}

/**
 * `error`'s stack captured from where `above` was called, headed `name:
 * message` (Node's prepareStackTrace heads a Node error so), its own name
 * then restored. V8 formats a stack when it is first read.
 */
function headStack(error: Error, name: string, above: Function): void {
  const own = Object.getOwnPropertyDescriptor(error, 'name');
  captureStack(error, above);
  Object.defineProperty(error, 'name', { value: name, enumerable: false, writable: true, configurable: true });
  void error.stack;
  if (own === undefined) Reflect.deleteProperty(error, 'name');
  else Object.defineProperty(error, 'name', own);
}

/** V8's Error.captureStackTrace (core's types are the language's, which have none). */
function captureStack(error: object, above: Function): void {
  const capture: unknown = Reflect.get(Error, 'captureStackTrace');
  if (typeof capture === 'function') Reflect.apply(capture, Error, [error, above]);
}
