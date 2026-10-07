/**
 * The shell's variables as bash keeps them: a scalar in `env`, or an array
 * (sparse, by index) in `arrays`, never both; and the names `readonly`
 * protects. The Shell's builtins (declare, export, read, readonly) and the
 * interpreter's assignments write through these, so each rule is stated
 * once: a readonly name refuses, a plain assignment to an array lands on
 * its first element, a subscripted one promotes a scalar to an array, and
 * an array literal replaces whatever the name held.
 */
export interface VariableStore {
    readonly env: Record<string, string>;
    readonly arrays: Map<string, (string | undefined)[]>;
    readonly readonlyNames: ReadonlySet<string>;
}
/** A variable's complete binding: its scalar value, or its array, or neither. */
export interface SavedVariable {
    readonly scalar: string | undefined;
    readonly array: (string | undefined)[] | undefined;
}
/** `name=value` (`name+=value` with `append`); on an array, its first element. False for a readonly name. */
export declare function assignVariable(store: VariableStore, name: string, value: string, append?: boolean): boolean;
/** `name=(value …)` (`name+=(…)` appends to the array). False for a readonly name. */
export declare function assignArray(store: VariableStore, name: string, values: readonly string[], append?: boolean): boolean;
/** The array behind a subscripted assignment, promoting a scalar to its element 0 if needed. */
export declare function arrayFor(store: VariableStore, name: string): (string | undefined)[];
/** One variable's whole binding, so a scope can put it back exactly. */
export declare function saveVariable(store: VariableStore, name: string): SavedVariable;
export declare function restoreVariable(store: VariableStore, name: string, saved: SavedVariable): void;
/** A copy of `arrays` whose arrays are copies too: what a subshell or a saved shell state holds. */
export declare function cloneArrays(arrays: ReadonlyMap<string, (string | undefined)[]>): Map<string, (string | undefined)[]>;
//# sourceMappingURL=variables.d.ts.map