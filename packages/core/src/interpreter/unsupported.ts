/**
 * unsupported.ts — the error of code the interpreter will not run.
 *
 * The guest's runtime-code service (_shared/commonjs-cell.ts) answers it
 * with the next-launch refusal, by its code: that module is part of the
 * host worker too, so the code lives in unsupported-code.ts, which loads
 * nothing (this module's class extends the launch's captured Error).
 */
import { Error } from './intrinsics.js';
import { INTERPRETER_UNSUPPORTED } from './unsupported-code.js';

export { INTERPRETER_UNSUPPORTED };

/** Code the interpreter does not run, refused before any of it runs. */
export class UnsupportedSyntax extends Error {
  readonly code = INTERPRETER_UNSUPPORTED;
}
