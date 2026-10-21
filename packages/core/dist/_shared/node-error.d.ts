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
type ErrorClass = new (message?: string) => Error;
/**
 * Node's error `code` on a `Base` (Error, TypeError, RangeError, …) with
 * `message`, and `props` set on it after (an `info`, a `cmd`). Its stack
 * starts at the caller of `above`: the frames above it are Node's own in Node.
 */
export declare function nodeError(Base: ErrorClass, code: string, message: string, props?: Record<string, unknown>, above?: Function): Error;
/**
 * An error another implementation made for Node's `code` on `Base` (the
 * builtins workerd provides: their own `name` and `toString`, a stack headed
 * without the code), given in place the shape nodeError gives one: its
 * class, `code` then `message` its own properties, its stack headed
 * `Name [CODE]: message` over the frames it has. Its other own properties
 * stay. Returns it.
 */
export declare function reshapeAsNodeError(error: Error, Base: ErrorClass, code: string): Error;
/** How a message shows a value only util.inspect can describe: the runtime's inspect once it is handed one. */
declare let inspectValue: (value: unknown, options: {
    depth?: number;
    colors?: boolean;
}) => string;
/** Hands the messages below the runtime's util.inspect (Node's lazyInternalUtilInspect). */
export declare function useNodeErrorInspect(inspect: typeof inspectValue): void;
/** How Node's messages describe a value they were given (lib/internal/errors.js determineSpecificType). */
export declare function determineSpecificType(value: unknown): string;
/**
 * Node's ERR_INVALID_ARG_TYPE: `name` (an argument, a `a.b` property, or a
 * `first argument`) must be one of `expected` — types (`string`), classes
 * (`Buffer`) or anything else (`Array-like Object`) — and was `actual`.
 */
export declare function invalidArgType(name: string, expected: string | readonly string[], actual: unknown): Error;
/** Node's ERR_INVALID_ARG_VALUE: `name` was `value`, refused for `reason` (`is invalid`, or what it must be). */
export declare function invalidArgValue(name: string, value: unknown, reason?: string): Error;
/** Node's ERR_TLS_CERT_ALTNAME_INVALID: `cert` does not name `host`, for `reason`. */
export declare function tlsCertAltnameInvalid(reason: string, host: string, cert: object): Error;
/** Node's ERR_TLS_CERT_ALTNAME_FORMAT: a quoted subject alternative name is not a JSON string. */
export declare function tlsCertAltnameFormat(): Error;
/** Node's ERR_OUT_OF_RANGE: `name` must be `range` (`an integer`, `>= 0 && <= 4294967295`), and was `input`. */
export declare function outOfRange(name: string, range: string, input: unknown): Error;
/** `new codes.ERR_X(...args)`: Node's error for the code, its stack from where it was made. */
export type NodeErrorConstructor = ((...args: never[]) => Error) & {
    [base: string]: NodeErrorConstructor;
};
/**
 * lib/internal/errors.js `codes` for the codes in nodeErrorMessages: each a
 * constructor of its class, its other bases' beside it by name, and the
 * HideStackFramesError Node's validators construct (the same error here;
 * hideStackFrames moves its stack).
 */
export declare const nodeErrorCodes: Readonly<Record<string, NodeErrorConstructor>>;
/**
 * lib/internal/errors.js hideStackFrames: `fn`, whose error's stack starts
 * where the wrapper was called; a Node error's stack keeps its code.
 */
export declare function hideStackFrames<F extends (...args: never[]) => unknown>(fn: F): F & {
    withoutStackTrace: F;
};
/** lib/internal/errors.js isErrorStackTraceLimitWritable. */
export declare function isErrorStackTraceLimitWritable(): boolean;
/** A system call's context, as Node's SystemError holds it (`info`), its keys in the order the call names them. */
export interface SystemErrorContext {
    code: string;
    message: string;
    syscall: string;
    errno: number;
    path?: string;
    dest?: string;
}
/**
 * Node's SystemError for `code` (its message `prefix`, as Node words it) and
 * a system call's `context`: `${prefix}: ${syscall} returned ${code}
 * (${message}) ${path} => ${dest}`, its `info` the context, and its errno,
 * syscall, path and dest that context's, read and written through. Node
 * inspects one with its getters' values.
 */
export declare function nodeSystemError(code: string, prefix: string, context: SystemErrorContext): Error;
/** Error.captureStackTrace as the runtime has it (primordials captureStackTraceOf; core's types are the language's, which have none). */
export declare function captureStack(error: object, above: Function): void;
export {};
//# sourceMappingURL=node-error.d.ts.map