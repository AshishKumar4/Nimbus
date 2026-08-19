/**
 * error-text.ts — the text a caught value carries.
 *
 * A `catch` binding is `unknown`: the throw site may have thrown an Error, a
 * string, or a plain object with a `message`, and the shell and runtime paths
 * report all three the same way. This is that report, in one place, so a
 * command's diagnostics do not depend on which of those a facet threw.
 */

/**
 * The message a thrown value names, or the value itself when it names none.
 * Empty and other falsy messages fall through to the value, so an
 * `new Error('')` still reports as `Error` rather than as nothing.
 */
export function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (message) return String(message);
  }
  return String(error);
}
