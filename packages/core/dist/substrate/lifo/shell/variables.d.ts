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
    readonly exportedNames: Set<string>;
    readonly declaredNames: Set<string>;
}
/** A store's values, which assignments read and write: arithmetic's (ArithmeticScope) as well as the shell's. */
export type ShellValues = Pick<VariableStore, 'env' | 'arrays' | 'readonlyNames'>;
/** A variable's complete binding: its scalar value, or its array, or neither; its export mark; whether it is declared with no value. */
export interface SavedVariable {
    readonly scalar: string | undefined;
    readonly array: (string | undefined)[] | undefined;
    readonly exported: boolean;
    readonly declared: boolean;
}
/** A variable dictionary: prototype names are ordinary variable names too. */
export declare function cloneEnv(source: Readonly<Record<string, string>>): Record<string, string>;
/** `name=value` (`name+=value` with `append`); on an array, its first element. False for a readonly name. */
export declare function assignVariable(store: ShellValues, name: string, value: string, append?: boolean): boolean;
/** An array literal's array, and bash's diagnostic for each element it refused and skipped. */
export interface ArrayLiteral {
    readonly array: (string | undefined)[];
    readonly refused: readonly string[];
}
/** `name=(…)`: `array` in place of whatever the name held. False for a readonly name. */
export declare function assignArray(store: VariableStore, name: string, array: (string | undefined)[]): boolean;
/** The highest index that holds a value, or -1: bash's array_max_index, past which `a+=(…)` goes on. */
export declare function lastIndex(array: readonly (string | undefined)[]): number;
/** The array behind a subscripted assignment, promoting a scalar to its element 0 if needed. */
export declare function arrayFor(store: ShellValues, name: string): (string | undefined)[];
/** One variable's whole binding, so a scope can put it back exactly: its array a copy, as what the scope does to it in place is not kept. */
export declare function saveVariable(store: VariableStore, name: string): SavedVariable;
/**
 * `name` bound again as `saved` holds it. `attributes`: its export mark and
 * declaredness too (a local's, at its function's return); a command's prefix
 * assignment gives back only its value (`x=1 export x` exports x).
 */
export declare function restoreVariable(store: VariableStore, name: string, saved: SavedVariable, attributes?: boolean): void;
/** A copy of `arrays` whose arrays are copies too: what a subshell or a saved shell state holds. */
export declare function cloneArrays(arrays: ReadonlyMap<string, (string | undefined)[]>): Map<string, (string | undefined)[]>;
/** A copy of `array`, its holes kept, however high its last index. */
export declare function copyArray(array: readonly (string | undefined)[]): (string | undefined)[];
/** A subscript's arithmetic as an index of `array`: a negative one counts back from past its last value (still negative where that is before the first). */
export declare function arrayIndex(array: readonly (string | undefined)[], value: number): number;
/**
 * A store's variables beyond `env`'s scalar values, as plain data, from the
 * store's own table: its export, readonly and declared marks, and its arrays,
 * each element an `[index, value]` pair (sparse). Names in order, so equal
 * stores give equal data. lifo keeps no other attribute (integer, case,
 * nameref, associative arrays are not implemented).
 */
export interface VariableAttributes {
    readonly exported: readonly string[];
    readonly readonly: readonly string[];
    readonly declared: readonly string[];
    readonly arrays: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>>;
}
/** `store`'s attributes (VariableAttributes). */
export declare function attributesOf(store: VariableStore): VariableAttributes;
/**
 * `attributes` put back into `store`, whose `env` holds the scalars they were
 * saved with (`scalars`, those names) and maybe others besides (a
 * workspace's). Every name the saved state binds (a scalar, an array, a mark)
 * is as it was saved: its scalar only if it had one, exported only if it
 * was. Any other keeps what it has.
 */
export declare function restoreAttributes(store: VariableStore & {
    readonly readonlyNames: Set<string>;
}, attributes: VariableAttributes, scalars: Iterable<string>): void;
//# sourceMappingURL=variables.d.ts.map