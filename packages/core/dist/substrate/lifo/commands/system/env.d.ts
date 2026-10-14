import type { Command } from '../types.js';
/**
 * env [-i] [-0] [-u NAME]... [--] [NAME=VALUE]... [COMMAND [ARG]...], as GNU
 * coreutils' env: COMMAND runs as a child with the environment the options
 * and assignments make; with none, that environment is printed, one entry a
 * line (NUL-ended with -0). A COMMAND that cannot be found is 127, one that
 * may not run 126, a bad option 125; otherwise env's status is COMMAND's.
 */
declare const command: Command;
export default command;
//# sourceMappingURL=env.d.ts.map