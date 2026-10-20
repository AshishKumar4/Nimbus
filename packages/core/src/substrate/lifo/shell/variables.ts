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

/** A variable's complete binding: its scalar value, or its array, or neither; its export mark; whether it is declared with no value. */
export interface SavedVariable {
  readonly scalar: string | undefined;
  readonly array: (string | undefined)[] | undefined;
  readonly exported: boolean;
  readonly declared: boolean;
}

/** A variable dictionary: prototype names are ordinary variable names too. */
export function cloneEnv(source: Readonly<Record<string, string>>): Record<string, string> {
  const env = { ...source };
  Object.setPrototypeOf(env, null);
  return env;
}

/** `name=value` (`name+=value` with `append`); on an array, its first element. False for a readonly name. */
export function assignVariable(store: VariableStore, name: string, value: string, append = false): boolean {
  if (store.readonlyNames.has(name)) return false;
  const array = store.arrays.get(name);
  if (array !== undefined) array[0] = append ? (array[0] ?? '') + value : value;
  else store.env[name] = append ? (store.env[name] ?? '') + value : value;
  return true;
}

/** An array literal's array, and bash's diagnostic for each element it refused and skipped. */
export interface ArrayLiteral {
  readonly array: (string | undefined)[];
  readonly refused: readonly string[];
}

/** `name=(…)`: `array` in place of whatever the name held. False for a readonly name. */
export function assignArray(store: VariableStore, name: string, array: (string | undefined)[]): boolean {
  if (store.readonlyNames.has(name)) return false;
  delete store.env[name];
  store.arrays.set(name, array);
  return true;
}

/** The highest index that holds a value, or -1: bash's array_max_index, past which `a+=(…)` goes on. */
export function lastIndex(array: readonly (string | undefined)[]): number {
  const end = array.length - 1;
  if (end < 0 || array[end] !== undefined) return end;
  // Past a removed last element: an array's own keys are its indices in order, the holes skipped, however high.
  let last = -1;
  for (const key of Object.keys(array)) if (array[Number(key)] !== undefined) last = Number(key);
  return last;
}

/** The array behind a subscripted assignment, promoting a scalar to its element 0 if needed. */
export function arrayFor(store: VariableStore, name: string): (string | undefined)[] {
  const existing = store.arrays.get(name);
  if (existing !== undefined) return existing;
  const scalar = store.env[name];
  const array: (string | undefined)[] = scalar === undefined ? [] : [scalar];
  delete store.env[name];
  store.arrays.set(name, array);
  return array;
}

/** One variable's whole binding, so a scope can put it back exactly: its array a copy, as what the scope does to it in place is not kept. */
export function saveVariable(store: VariableStore, name: string): SavedVariable {
  const array = store.arrays.get(name);
  return { scalar: store.env[name], array: array === undefined ? undefined : copyArray(array), exported: store.exportedNames.has(name), declared: store.declaredNames.has(name) };
}

/**
 * `name` bound again as `saved` holds it. `attributes`: its export mark and
 * declaredness too (a local's, at its function's return); a command's prefix
 * assignment gives back only its value (`x=1 export x` exports x).
 */
export function restoreVariable(store: VariableStore, name: string, saved: SavedVariable, attributes = true): void {
  if (saved.array === undefined) store.arrays.delete(name);
  else store.arrays.set(name, saved.array);
  if (saved.scalar === undefined) delete store.env[name];
  else store.env[name] = saved.scalar;
  if (!attributes) return;
  if (saved.exported) store.exportedNames.add(name);
  else store.exportedNames.delete(name);
  if (saved.declared) store.declaredNames.add(name);
  else store.declaredNames.delete(name);
}

/** A copy of `arrays` whose arrays are copies too: what a subshell or a saved shell state holds. */
export function cloneArrays(arrays: ReadonlyMap<string, (string | undefined)[]>): Map<string, (string | undefined)[]> {
  return new Map(Array.from(arrays, ([name, elements]) => [name, copyArray(elements)]));
}

/** A copy of `array`, its holes kept, however high its last index. */
export function copyArray(array: readonly (string | undefined)[]): (string | undefined)[] {
  const copy: (string | undefined)[] = [];
  for (const key of Object.keys(array)) copy[Number(key)] = array[Number(key)];
  return copy;
}

/** A subscript's arithmetic as an index of `array`: a negative one counts back from past its last value (still negative where that is before the first). */
export function arrayIndex(array: readonly (string | undefined)[], value: number): number {
  return value < 0 ? lastIndex(array) + 1 + value : value;
}

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
export function attributesOf(store: VariableStore): VariableAttributes {
  const arrays: Record<string, Array<readonly [number, string]>> = Object.create(null);
  for (const name of [...store.arrays.keys()].sort()) {
    const array = store.arrays.get(name) ?? [];
    const elements: Array<readonly [number, string]> = [];
    for (const key of Object.keys(array)) {
      const value = array[Number(key)];
      if (value !== undefined) elements.push([Number(key), value]);
    }
    arrays[name] = elements;
  }
  return {
    exported: [...store.exportedNames].sort(),
    readonly: [...store.readonlyNames].sort(),
    declared: [...store.declaredNames].sort(),
    arrays,
  };
}

/**
 * `attributes` put back into `store`, whose `env` holds the scalars they were
 * saved with (`scalars`, those names) and maybe others besides (a
 * workspace's). Every name the saved state binds (a scalar, an array, a mark)
 * is as it was saved: its scalar only if it had one, exported only if it
 * was. Any other keeps what it has.
 */
export function restoreAttributes(
  store: VariableStore & { readonly readonlyNames: Set<string> },
  attributes: VariableAttributes,
  scalars: Iterable<string>,
): void {
  const saved = new Set(scalars);
  const exported = new Set(attributes.exported);
  const bound = new Set([...saved, ...exported, ...attributes.readonly, ...attributes.declared, ...Object.keys(attributes.arrays)]);
  for (const name of bound) {
    if (!saved.has(name)) delete store.env[name];
    if (exported.has(name)) store.exportedNames.add(name);
    else store.exportedNames.delete(name);
  }
  for (const name of attributes.readonly) store.readonlyNames.add(name);
  for (const name of attributes.declared) store.declaredNames.add(name);
  for (const [name, elements] of Object.entries(attributes.arrays)) {
    const array: (string | undefined)[] = [];
    for (const [index, value] of elements) array[index] = value;
    store.arrays.set(name, array);
  }
}
