/**
 * find(1), as GNU findutils 4.10 behaves for the expression language it
 * implements (see find/expression.ts for what is refused, and why).
 *
 * The command line is parsed whole before anything is visited; the walk
 * (find/walk.ts) hands each file to the expression in fts order, reading
 * ahead of it when the expression only looks; commands run by -exec and
 * -execdir are child processes started through the shell (`runAs` with the
 * caller's own credential), from find's directory or the file's.
 */
import type { Command } from '../types.js';
declare const command: Command;
export default command;
//# sourceMappingURL=find.d.ts.map