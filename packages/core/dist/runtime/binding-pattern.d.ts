/**
 * binding-pattern.ts — the identifiers a binding pattern binds, in source
 * order: an identifier, and what the parts of an object or array pattern, a
 * rest element and a default bind. A member expression is an assignment
 * target, not a binding, and an array hole binds nothing.
 *
 * Reads only ESTree's fields, so it serves acorn's trees, rolldown's and the
 * interpreter's own copies alike; callers differ only in what they do with
 * each identifier. The interpreter runs it after a program may have replaced
 * built-ins, so it names none (tests/unit/interpreter-primordials.mjs).
 */
import type { Identifier, Pattern } from 'acorn';
/**
 * Calls `visit` with each identifier `pattern` binds, and `context`: a caller
 * whose closures must keep nothing (the interpreter's) passes what it needs
 * there instead of closing over it.
 */
export declare function forEachBindingIdentifier(pattern: Pattern | null, visit: (identifier: Identifier) => void): void;
export declare function forEachBindingIdentifier<C>(pattern: Pattern | null, visit: (identifier: Identifier, context: C) => void, context: C): void;
//# sourceMappingURL=binding-pattern.d.ts.map