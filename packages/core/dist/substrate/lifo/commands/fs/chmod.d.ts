import type { Command } from '../types.js';
interface SymbolicClause {
    who: string;
    op: '+' | '-' | '=';
    perms: string;
}
export type ModeSpec = {
    kind: 'absolute';
    mode: number;
} | {
    kind: 'symbolic';
    clauses: SymbolicClause[];
};
/** Parse an octal (755, 0644) or symbolic (+x, u+x, go-w, a=rx, a+rX) mode spec. */
export declare function parseModeSpec(spec: string): ModeSpec | null;
/**
 * Apply a parsed mode spec to the current permission bits. `isDir`
 * feeds the conditional-execute perm: 'X' grants x only to directories
 * and files that already have some exec bit (chmod(1) semantics —
 * `chmod -R a+rX` is a staple of npm postinstall scripts).
 */
export declare function applyModeSpec(spec: ModeSpec, currentMode: number, isDir?: boolean): number;
declare const command: Command;
export default command;
//# sourceMappingURL=chmod.d.ts.map