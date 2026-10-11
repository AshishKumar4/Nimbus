/** Shared by the host and compiled guest: what identifies and charges runtime code. */
import type { RuntimeCodeEntry } from './commonjs-cell.js';
/** A module's directory and extension determine its resolution/lowering; its basename does not. */
export declare function runtimeModuleScope(path: string): [dir: string, ext: string];
/** Both sides hash the same source, with a module's import/lowering scope. */
export declare function runtimeCodeKeySource(entry: RuntimeCodeEntry): string;
/** Text, the retained path, and bounded bookkeeping overhead; data URLs hold the source twice. */
export declare function runtimeCodeSourceCharge(source: string, entry: RuntimeCodeEntry): number;
//# sourceMappingURL=runtime-code-identity.d.ts.map