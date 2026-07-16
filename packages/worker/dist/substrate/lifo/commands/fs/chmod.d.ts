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
/** Parse an octal (755, 0644) or symbolic (+x, u+x, go-w, a=rx) mode spec. */
export declare function parseModeSpec(spec: string): ModeSpec | null;
/** Apply a parsed mode spec to the current permission bits. */
export declare function applyModeSpec(spec: ModeSpec, currentMode: number): number;
declare const command: Command;
export default command;
//# sourceMappingURL=chmod.d.ts.map