// How a CI command-line script ends on an error, and how its caller says why.
// The script prints the stack, then the cause alone on its last line. A caller
// quotes that line, since it may keep only the tail of what the script printed.

/** `error`, printed as the last words of the script's `command`: its stack, then `<command> failed: <cause>`. */
export function printFailure(command, error) {
  if (error instanceof Error && error.stack) console.error(error.stack);
  console.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** The cause a failed script's `stderr` ends with (printFailure). */
export function causeOf(stderr) {
  return stderr.trimEnd().split('\n').at(-1) ?? '';
}
