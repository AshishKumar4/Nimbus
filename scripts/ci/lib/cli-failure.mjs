// How a CI command-line script ends on an error, and how its caller says why.
// The script's last line is `<command> failed: <cause>`, the cause on one line
// and the stack above it, so a caller that keeps only the tail of what the
// script printed still holds the cause.

const FAILED_LINE = /^[\w-]+ failed: /;

/** `error`, printed as the last words of the script's `command`: its stack, then `<command> failed: <cause>`. */
export function printFailure(command, error) {
  if (error instanceof Error && error.stack) console.error(error.stack);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${command} failed: ${message.split('\n').map((line) => line.trim()).filter(Boolean).join(' / ')}`);
}

/**
 * Why a child script failed, as its caller quotes it: the error that kept it
 * from starting, else its printFailure line, else nothing (one that ended
 * otherwise, an older checkout's among them, is read from its stderr whole).
 *
 * @param {{ error?: Error, stderr?: string | null }} child
 */
export function causeOf({ error, stderr }) {
  if (error) return error.message;
  const last = (stderr ?? '').trimEnd().split('\n').at(-1) ?? '';
  return FAILED_LINE.test(last) ? last : '';
}
