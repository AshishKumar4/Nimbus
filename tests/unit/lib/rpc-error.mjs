// An error as the caller of a workerd RPC receives it when both isolates run
// with enhanced_error_serialization (on by compatibility date from
// 2026-04-21): a new error of the thrower's type (a standard constructor, or
// Error bearing the thrower's name) carrying its message and its own
// properties, `code` among them, but not its stack, which the receiver drops
// (src/workerd/jsg/ser.c++, Serializer::WriteHostObject and
// Deserializer::ReadHostObject with preserveStackInErrors off). A thrown
// value that is not an error arrives as an error with its string as the
// message.
const STANDARD = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };

export function acrossRpc(error) {
  if (!(error instanceof Error)) return new Error(String(error));
  const Standard = Object.hasOwn(STANDARD, error.name) ? STANDARD[error.name] : undefined;
  const received = new (Standard ?? Error)(error.message);
  if (!Standard && error.name !== 'Error') {
    Object.defineProperty(received, 'name', { value: error.name, configurable: true, writable: true });
  }
  for (const key of Reflect.ownKeys(error)) {
    if (key === 'message' || key === 'stack') continue;
    Object.defineProperty(received, key, { value: error[key], configurable: true, enumerable: true, writable: true });
  }
  return received;
}
