/** The shell's two name predicates, for every builtin and expansion that checks a name. */
/** A variable, function or alias name, as POSIX spells one: a letter or `_`, then letters, digits and `_`. */
export declare function isShellIdentifier(value: string): boolean;
/** Decimal digits and nothing else: a positional parameter, a file descriptor, a count. */
export declare function isDecimalInteger(value: string): boolean;
//# sourceMappingURL=names.d.ts.map