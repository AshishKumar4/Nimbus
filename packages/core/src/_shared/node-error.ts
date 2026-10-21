/**
 * node-error.ts — Node's internal errors, as lib/internal/errors.js (v22.23.4)
 * makes them, for every error the runtime gives a code: the guest's shims and
 * module resolver, the shell's own Node compatibility, and the host code that
 * shares them. A NodeError reads `Name [CODE]: message` in its stack and its
 * toString(), carries its code as its own enumerable `code`, and is an
 * instance of its base class, whose name and constructor it reports; a
 * SystemError (`fs.rm` of a directory, `fs.cp` onto a file) adds the
 * system call's context.
 *
 * Self-contained but for the built-ins it calls, captured before any
 * program code (primordials.ts): scripts/bundle-facet-workers.mjs compiles
 * it into the guest's shims (NODE_ERROR_PREAMBLE), which call it by name
 * and hand it to the cell runtime and generated code as `__nimbusNodeError`
 * and `__nimbusNodeSystemError`, and the module resolver throws its errors
 * after a program may have replaced built-ins.
 */

import {
  arrayIncludes, arrayJoin, captureStackTraceOf, dataDescriptor, Error, JSONStringify, mathAbs, numberIsInteger,
  objectAssign, objectCreate, objectHasOwn, objectIs, objectIsExtensible, objectKeys, ownField, RangeError, reflectApply,
  reflectDefineProperty, reflectDeleteProperty, reflectGet, reflectGetOwnPropertyDescriptor, reflectGetPrototypeOf, reflectHas,
  reflectSet, reflectSetPrototypeOf, regExpExec, SafeList, SafeMap, SafeWeakMap, stringIncludes, stringIndexOf, stringOf,
  stringSlice, stringEndsWith, stringToLowerCase, symbolFor, SyntaxError, TypeError, URIError,
} from './primordials.js';

type ErrorClass = new (message?: string) => Error;

/** One class per base and code, as Node makes one per code. */
const nodeErrorClasses = new SafeMap<ErrorClass, SafeMap<string, ErrorClass>>();
/** Each class's code, by its prototype. */
const classCodes = new SafeWeakMap<object, string>();

/** An accessor property descriptor that inherits nothing (dataDescriptor's, for a getter and a setter). */
function accessorDescriptor(get: () => unknown, set: ((value: never) => void) | undefined, enumerable: boolean, configurable: boolean): PropertyDescriptor {
  const descriptor: PropertyDescriptor = objectCreate(null);
  descriptor.get = get;
  if (set !== undefined) descriptor.set = set;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

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
  headStack(error, `${reflectGet(error, 'name')} [${code}]`, above);
  if (props !== undefined) objectAssign(error, props);
  return error;
}

/** Node's class for a code on a base (Error, TypeError, …), made once. */
function nodeErrorClass(Base: ErrorClass, code: string): ErrorClass {
  let classes = nodeErrorClasses.get(Base);
  if (classes === undefined) nodeErrorClasses.set(Base, (classes = new SafeMap()));
  let NodeError = classes.get(code);
  if (NodeError === undefined) {
    NodeError = class extends Base {
      constructor(text?: string) {
        // The message reaches the constructor: workerd's V8 heads a stack
        // with the message an error was built with, not its property.
        super(text);
        reflectDeleteProperty(this, 'message');
        // Own and enumerable, then the message, as Node's class field and constructor leave them.
        reflectDefineProperty(this, 'code', dataDescriptor(code, true, true, true));
        reflectDefineProperty(this, 'message', dataDescriptor(text, true, false, true));
      }

      toString(): string {
        return `${reflectGet(this, 'name')} [${code}]: ${reflectGet(this, 'message')}`;
      }
    };
    // What Node's NodeError reports as its constructor: its base.
    reflectDefineProperty(NodeError.prototype, 'constructor', accessorDescriptor(() => Base, undefined, false, true));
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
  const message: unknown = reflectGet(error, 'message');
  let stack: unknown;
  try {
    stack = reflectGet(error, 'stack');
  } catch {
    stack = undefined;
  }
  const NodeError = nodeErrorClass(Base, code);
  const stackDescriptor = reflectGetOwnPropertyDescriptor(error, 'stack');
  const replaced = ['stack', 'code', 'message', 'name', 'toString'];
  for (let i = 0; i < replaced.length; i++) reflectDeleteProperty(error, replaced[i]);
  reflectSetPrototypeOf(error, NodeError.prototype);
  if (stackDescriptor !== undefined) reflectDefineProperty(error, 'stack', stackDescriptor);
  reflectDefineProperty(error, 'code', dataDescriptor(code, true, true, true));
  reflectDefineProperty(error, 'message', dataDescriptor(message, true, false, true));
  if (typeof stack === 'string') {
    const frames = stringIndexOf(stack, '\n    at ');
    const name: unknown = reflectGet(Base, 'name');
    const header = message === '' ? `${name} [${code}]` : `${name} [${code}]: ${message}`;
    reflectSet(error, 'stack', header + (frames === -1 ? '' : stringSlice(stack, frames)));
  }
  return error;
}

/** How a message shows a value only util.inspect can describe: the runtime's inspect once it is handed one. */
let inspectValue: (value: unknown, options: { depth?: number; colors?: boolean }) => string = (value) => stringOf(value);

/** Hands the messages below the runtime's util.inspect (Node's lazyInternalUtilInspect). */
export function useNodeErrorInspect(inspect: typeof inspectValue): void {
  inspectValue = inspect;
}

/** The `expected` names ERR_INVALID_ARG_TYPE words as types (lib/internal/errors.js kTypes). */
const ARG_TYPES = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];
const CLASS_NAME = /^[A-Z][a-zA-Z0-9]*$/;

/** `A`, `A or B`, `A, B, or C` (lib/internal/errors.js formatList). */
function formatList(items: readonly string[], type: string): string {
  if (items.length < 3) return arrayJoin(items, ` ${type} `);
  let head = '';
  for (let i = 0; i < items.length - 1; i++) head += i === 0 ? items[i] : `, ${items[i]}`;
  return `${head}, ${type} ${items[items.length - 1]}`;
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
    case 'symbol': return `type symbol (${stringOf(value)})`;
    case 'function': return `function ${reflectGet(value, 'name')}`;
    case 'object': {
      const ctor: unknown = reflectGet(value, 'constructor');
      if ((typeof ctor === 'function' || (typeof ctor === 'object' && ctor !== null)) && reflectHas(ctor, 'name')) {
        return `an instance of ${stringOf(reflectGet(ctor, 'name'))}`;
      }
      return inspectValue(value, { depth: -1 });
    }
    case 'string': {
      const shown = value.length > 28 ? `${stringSlice(value, 0, 25)}...` : value;
      return stringIncludes(shown, "'") ? `type string (${JSONStringify(shown)})` : `type string ('${shown}')`;
    }
    default: {
      let shown = inspectValue(value, { colors: false });
      if (shown.length > 28) shown = `${stringSlice(shown, 0, 25)}...`;
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

/** Node's ERR_INVALID_ARG_VALUE: `name` was `value`, refused for `reason` (`is invalid`, or what it must be). */
export function invalidArgValue(name: string, value: unknown, reason = 'is invalid'): Error {
  return made(TypeError, 'ERR_INVALID_ARG_VALUE', invalidArgValueMessage(name, value, reason), undefined, invalidArgValue);
}

function invalidArgValueMessage(name: string, value: unknown, reason = 'is invalid'): string {
  let inspected = inspectValue(value, {});
  if (inspected.length > 128) inspected = `${stringSlice(inspected, 0, 128)}...`;
  return `The ${stringIncludes(name, '.') ? 'property' : 'argument'} '${name}' ${reason}. Received ${inspected}`;
}

/** Node's ERR_OUT_OF_RANGE: `name` must be `range` (`an integer`, `>= 0 && <= 4294967295`), and was `input`. */
export function outOfRange(name: string, range: string, input: unknown): Error {
  return made(RangeError, 'ERR_OUT_OF_RANGE', outOfRangeMessage(name, range, input), undefined, outOfRange);
}

function outOfRangeMessage(str: string, range: string, input: unknown, replaceDefaultBoolean = false): string {
  let received: string;
  if (typeof input === 'number' && numberIsInteger(input) && mathAbs(input) > 2 ** 32) {
    received = addNumericalSeparator(stringOf(input));
  } else if (typeof input === 'bigint') {
    received = stringOf(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
    received += 'n';
  } else {
    received = inspectValue(input, {});
  }
  return `${replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`} It must be ${range}. Received ${received}`;
}

function invalidArgTypeMessage(name: string, expected: string | readonly string[], actual: unknown): string {
  let types = new SafeList<string>();
  const instances = new SafeList<string>();
  const other = new SafeList<string>();
  const given = typeof expected === 'string' ? [expected] : expected;
  for (let i = 0; i < given.length; i++) {
    const value = given[i];
    if (arrayIncludes(ARG_TYPES, value)) types[types.length] = stringToLowerCase(value);
    else if (regExpExec(CLASS_NAME, value) !== null) instances[instances.length] = value;
    else other[other.length] = value;
  }
  // `object` beside classes is worded as one of them.
  if (instances.length > 0 && arrayIncludes(types, 'object')) {
    const kept = new SafeList<string>();
    let removed = false;
    for (let i = 0; i < types.length; i++) {
      if (!removed && types[i] === 'object') removed = true;
      else kept[kept.length] = types[i];
    }
    types = kept;
    instances[instances.length] = 'Object';
  }
  let message = stringEndsWith(name, ' argument') ? `The ${name} must be ` : `The "${name}" ${stringIncludes(name, '.') ? 'property' : 'argument'} must be `;
  if (types.length > 0) {
    message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) message += ' or ';
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) message += ' or ';
  }
  if (other.length > 1) message += `one of ${formatList(other, 'or')}`;
  else if (other.length === 1) message += `${stringToLowerCase(other[0]) !== other[0] ? 'an ' : ''}${other[0]}`;
  return `${message}. Received ${determineSpecificType(actual)}`;
}

/** `1_000_000` (lib/internal/errors.js addNumericalSeparator). */
function addNumericalSeparator(value: string): string {
  let result = '';
  let i = value.length;
  const start = value[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${stringSlice(value, i - 3, i)}${result}`;
  return `${stringSlice(value, 0, i)}${result}`;
}

/** util.format's `%s` of what Node's messages are handed. */
function formatNodeMessage(template: string, args: readonly unknown[]): string {
  let out = '';
  let from = 0;
  let i = 0;
  for (let at = stringIndexOf(template, '%s'); at !== -1; at = stringIndexOf(template, '%s', from)) {
    const value = args[i++];
    out += stringSlice(template, from, at) + (typeof value === 'number' && objectIs(value, -0) ? '-0' : stringOf(value));
    from = at + 2;
  }
  return out + stringSlice(template, from);
}

type Message = string | ((...args: never[]) => string);

/**
 * Node's message for each code lib/internal/errors.js defines (its E()) that
 * the runtime raises through `codes`, and the code's bases: its class's
 * first, the others named beside it (`codes.ERR_INVALID_ARG_VALUE.RangeError`).
 */
const nodeErrorMessages: Record<string, { readonly message: Message; readonly bases: readonly [ErrorClass, ...ErrorClass[]] }> = {
  ERR_AMBIGUOUS_ARGUMENT: { message: 'The "%s" argument is ambiguous. %s', bases: [TypeError] },
  ERR_ASSERTION: { message: '%s', bases: [Error] },
  ERR_FEATURE_UNAVAILABLE_ON_PLATFORM: { message: 'The feature %s is unavailable on the current platform, which is being used to run Node.js', bases: [TypeError] },
  ERR_CONSTRUCT_CALL_REQUIRED: { message: 'Class constructor %s cannot be invoked without `new`', bases: [TypeError] },
  ERR_CRYPTO_ENGINE_UNKNOWN: { message: 'Engine "%s" was not found', bases: [Error] },
  ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE: { message: 'Invalid key object type %s, expected %s.', bases: [TypeError] },
  ERR_CRYPTO_SIGN_KEY_REQUIRED: { message: 'No key provided to sign', bases: [Error] },
  ERR_FALSY_VALUE_REJECTION: { message: function (this: Record<string, unknown>, reason: unknown) {
    this.reason = reason;
    return 'Promise was rejected with falsy value';
  }, bases: [Error] },
  ERR_ILLEGAL_CONSTRUCTOR: { message: 'Illegal constructor', bases: [TypeError] },
  ERR_INTERNAL_ASSERTION: { message: (message?: string) => {
    const suffix = 'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n'
      + 'Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n';
    return message === undefined ? suffix : `${message}\n${suffix}`;
  }, bases: [Error] },
  ERR_INCOMPATIBLE_OPTION_PAIR: { message: 'Option "%s" cannot be used in combination with option "%s"', bases: [TypeError] },
  ERR_INVALID_IP_ADDRESS: { message: 'Invalid IP address: %s', bases: [TypeError] },
  ERR_INVALID_ARG_TYPE: { message: invalidArgTypeMessage, bases: [TypeError] },
  ERR_DNS_SET_SERVERS_FAILED: { message: (error: string, servers: readonly string[]) => `c-ares failed to set servers: "${error}" [${inspectValue(servers, {})}]`, bases: [Error] },
  ERR_INVALID_MIME_SYNTAX: { message: (production: string, str: string, invalidIndex: number) =>
    `The MIME syntax for a ${production} in "${str}" is invalid${invalidIndex !== -1 ? ` at ${invalidIndex}` : ''}`, bases: [TypeError] },
  ERR_INVALID_ARG_VALUE: { message: invalidArgValueMessage, bases: [TypeError, RangeError] },
  ERR_INVALID_RETURN_VALUE: { message: (input: string, name: string, value: unknown) =>
    `Expected ${input} to be returned from the "${name}" function but got ${determineSpecificType(value)}.`, bases: [TypeError, RangeError] },
  ERR_INVALID_THIS: { message: 'Value of "this" must be of type %s', bases: [TypeError] },
  ERR_INVALID_URI: { message: 'URI malformed', bases: [URIError] },
  ERR_METHOD_NOT_IMPLEMENTED: { message: 'The %s method is not implemented', bases: [Error] },
  ERR_MISSING_ARGS: { message: (...names: (string | string[])[]) => {
    const wrapped = new SafeList<string>();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (typeof name === 'string') {
        wrapped[wrapped.length] = `"${name}"`;
        continue;
      }
      let either = '';
      for (let j = 0; j < name.length; j++) either += j === 0 ? `"${name[j]}"` : ` or "${name[j]}"`;
      wrapped[wrapped.length] = either;
    }
    return `The ${formatList(wrapped, 'and')} argument${names.length > 1 ? 's' : ''} must be specified`;
  }, bases: [TypeError] },
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: { message: '%s', bases: [TypeError] },
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: { message: "Unexpected argument '%s'. This command does not take positional arguments", bases: [TypeError] },
  ERR_PARSE_ARGS_UNKNOWN_OPTION: { message: (option: string, allowPositionals: boolean) => `Unknown option '${option}'${allowPositionals
    ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSONStringify(option)}`
    : ''}`, bases: [TypeError] },
  ERR_OPERATION_FAILED: { message: 'Operation failed: %s', bases: [Error, TypeError] },
  ERR_OUT_OF_RANGE: { message: outOfRangeMessage, bases: [RangeError] },
  ERR_SOCKET_BAD_PORT: { message: (name: string, port: unknown, allowZero = true) =>
    `${name} should be ${allowZero ? '>=' : '>'} 0 and < 65536. Received ${determineSpecificType(port)}.`, bases: [RangeError] },
  ERR_TLS_CERT_ALTNAME_FORMAT: { message: 'Invalid subject alternative name string', bases: [SyntaxError] },
  ERR_TLS_CERT_ALTNAME_INVALID: { message: function (this: Record<string, unknown>, reason: string, host: string, cert: object) {
    this.reason = reason;
    this.host = host;
    this.cert = cert;
    return `Hostname/IP does not match certificate's altnames: ${reason}`;
  }, bases: [Error] },
  ERR_UNAVAILABLE_DURING_EXIT: { message: 'Cannot call function in process exit handler', bases: [Error] },
  ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET: { message: '`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active', bases: [Error] },
  ERR_UNKNOWN_SIGNAL: { message: 'Unknown signal: %s', bases: [TypeError] },
  ERR_WORKER_UNSUPPORTED_OPERATION: { message: '%s is not supported in workers', bases: [TypeError] },
};

/** lib/internal/errors.js's SystemError codes, by the prefix each message starts with. */
const nodeSystemErrorPrefixes: Record<string, string> = {
  ERR_FS_CP_DIR_TO_NON_DIR: 'Cannot overwrite non-directory with directory',
  ERR_FS_CP_EEXIST: 'Target already exists',
  ERR_FS_CP_EINVAL: 'Invalid src or dest',
  ERR_FS_CP_FIFO_PIPE: 'Cannot copy a FIFO pipe',
  ERR_FS_CP_NON_DIR_TO_DIR: 'Cannot overwrite directory with non-directory',
  ERR_FS_CP_SOCKET: 'Cannot copy a socket file',
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: 'Cannot overwrite symlink in subdirectory of self',
  ERR_FS_CP_UNKNOWN: 'Cannot copy an unknown file type',
  ERR_FS_EISDIR: 'Path is a directory',
  ERR_SYSTEM_ERROR: 'A system error occurred',
};

/** `new codes.ERR_X(...args)`: Node's error for the code, its stack from where it was made. */
export type NodeErrorConstructor = ((...args: never[]) => Error) & { [base: string]: NodeErrorConstructor };

function nodeErrorCodeConstructor(code: string, message: Message, Base: ErrorClass): NodeErrorConstructor {
  const make = function (...args: never[]): Error {
    if (typeof message === 'string') return made(Base, code, formatNodeMessage(message, args), undefined, make);
    // A message that sets fields on its error (ERR_FALSY_VALUE_REJECTION's reason) sets them after its code.
    const fields: Record<string, unknown> = {};
    const text = reflectApply(message, fields, args);
    return made(Base, code, text, objectKeys(fields).length > 0 ? fields : undefined, make);
  } as NodeErrorConstructor;
  reflectDefineProperty(make, 'name', dataDescriptor('NodeError', false, false, true));
  return make;
}

/**
 * lib/internal/errors.js `codes` for the codes in nodeErrorMessages: each a
 * constructor of its class, its other bases' beside it by name, and the
 * HideStackFramesError Node's validators construct (the same error here;
 * hideStackFrames moves its stack).
 */
export const nodeErrorCodes: Readonly<Record<string, NodeErrorConstructor>> = makeNodeErrorCodes();

function makeNodeErrorCodes(): Record<string, NodeErrorConstructor> {
  const codes: Record<string, NodeErrorConstructor> = {};
  const messageCodes = objectKeys(nodeErrorMessages);
  for (let i = 0; i < messageCodes.length; i++) {
    const code = messageCodes[i];
    const { message, bases } = nodeErrorMessages[code];
    const constructor = nodeErrorCodeConstructor(code, message, bases[0]);
    constructor.HideStackFramesError = constructor;
    for (let j = 1; j < bases.length; j++) {
      const Other = bases[j];
      const other = nodeErrorCodeConstructor(code, message, Other);
      other.HideStackFramesError = other;
      constructor[reflectGet(Other, 'name')] = other;
    }
    codes[code] = constructor;
  }
  // Node's SystemError codes: `new codes.ERR_X(context)`, as lib/internal/errors.js E(code, prefix, SystemError).
  const systemCodes = objectKeys(nodeSystemErrorPrefixes);
  for (let i = 0; i < systemCodes.length; i++) {
    const code = systemCodes[i];
    const prefix = nodeSystemErrorPrefixes[code];
    const constructor = function (context: SystemErrorContext): Error { return nodeSystemError(code, prefix, context); } as unknown as NodeErrorConstructor;
    constructor.HideStackFramesError = constructor;
    codes[code] = constructor;
  }
  return codes;
}

/**
 * lib/internal/errors.js hideStackFrames: `fn`, whose error's stack starts
 * where the wrapper was called; a Node error's stack keeps its code.
 */
export function hideStackFrames<F extends (...args: never[]) => unknown>(fn: F): F & { withoutStackTrace: F } {
  const wrapped = function (this: unknown, ...args: never[]): unknown {
    try {
      return reflectApply(fn, this, args);
    } catch (error) {
      if (reflectGet(Error, 'stackTraceLimit') && error !== null && typeof error === 'object') {
        const prototype = reflectGetPrototypeOf(error);
        const code = prototype === null ? undefined : classCodes.get(prototype);
        if (code !== undefined) headStack(error, `${reflectGet(error, 'name')} [${code}]`, wrapped);
        else captureStack(error, wrapped);
      }
      throw error;
    }
  } as F & { withoutStackTrace: F };
  wrapped.withoutStackTrace = fn;
  return wrapped;
}

/** lib/internal/errors.js isErrorStackTraceLimitWritable. */
export function isErrorStackTraceLimitWritable(): boolean {
  const descriptor = reflectGetOwnPropertyDescriptor(Error, 'stackTraceLimit');
  if (descriptor === undefined) return objectIsExtensible(Error);
  return objectHasOwn(descriptor, 'writable') ? descriptor.writable === true : descriptor.set !== undefined;
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
  const path = ownField(context, 'path');
  const dest = ownField(context, 'dest');
  if (path !== undefined) message += ` ${path}`;
  if (dest !== undefined) message += ` => ${dest}`;
  SystemErrorClass ??= class SystemError extends Error {
    declare code: string;

    constructor(errorCode: string, text: string, info: SystemErrorContext) {
      // Built with its message, which heads its stack (NodeError above).
      super(text);
      reflectDeleteProperty(this, 'message');
      this.code = errorCode;
      const through = (key: 'errno' | 'syscall' | 'path' | 'dest'): PropertyDescriptor =>
        accessorDescriptor(() => info[key], (value: never) => { info[key] = value; }, true, true);
      reflectDefineProperty(this, 'name', dataDescriptor('SystemError', true, false, true));
      reflectDefineProperty(this, 'message', dataDescriptor(text, true, false, true));
      reflectDefineProperty(this, 'info', dataDescriptor(info, false, true, true));
      reflectDefineProperty(this, 'errno', through('errno'));
      reflectDefineProperty(this, 'syscall', through('syscall'));
      if (ownField(info, 'path') !== undefined) reflectDefineProperty(this, 'path', through('path'));
      if (ownField(info, 'dest') !== undefined) reflectDefineProperty(this, 'dest', through('dest'));
    }

    toString(): string {
      return `${reflectGet(this, 'name')} [${this.code}]: ${reflectGet(this, 'message')}`;
    }

    // util.inspect's third argument is inspect itself.
    [symbolFor('nodejs.util.inspect.custom')](_depth: number, options: object, inspect: (value: unknown, options: object) => string): string {
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
function headStack(error: object, name: string, above: Function): void {
  const own = reflectGetOwnPropertyDescriptor(error, 'name');
  captureStack(error, above);
  reflectDefineProperty(error, 'name', dataDescriptor(name, true, false, true));
  reflectGet(error, 'stack');
  if (own === undefined) reflectDeleteProperty(error, 'name');
  else reflectDefineProperty(error, 'name', own);
}

/** Error.captureStackTrace as the runtime has it (primordials captureStackTraceOf; core's types are the language's, which have none). */
export function captureStack(error: object, above: Function): void {
  const capture = captureStackTraceOf();
  if (typeof capture === 'function') reflectApply(capture, Error, [error, above]);
}
