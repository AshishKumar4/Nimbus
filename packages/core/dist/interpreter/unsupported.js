/**
 * The error code of code the interpreter will not run (UnsupportedSyntax),
 * which the guest answers with its next-launch refusal instead.
 */
export const INTERPRETER_UNSUPPORTED = 'ERR_NIMBUS_INTERPRETER_UNSUPPORTED';
/** Code the interpreter does not run, refused before any of it runs. */
export class UnsupportedSyntax extends Error {
    code = INTERPRETER_UNSUPPORTED;
}
