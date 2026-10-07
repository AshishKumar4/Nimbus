/** The shell's two name predicates, for every builtin and expansion that checks a name. */

/** A variable, function or alias name, as POSIX spells one: a letter or `_`, then letters, digits and `_`. */
export function isShellIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Decimal digits and nothing else: a positional parameter, a file descriptor, a count. */
export function isDecimalInteger(value: string): boolean {
  return /^[0-9]+$/.test(value);
}
