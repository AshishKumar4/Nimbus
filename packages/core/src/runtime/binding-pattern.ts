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
export function forEachBindingIdentifier(pattern: Pattern | null, visit: (identifier: Identifier) => void): void;
export function forEachBindingIdentifier<C>(pattern: Pattern | null, visit: (identifier: Identifier, context: C) => void, context: C): void;
export function forEachBindingIdentifier<C>(pattern: Pattern | null, visit: (identifier: Identifier, context: C) => void, context?: C): void {
  if (pattern === null) return;
  switch (pattern.type) {
    case 'Identifier':
      visit(pattern, context as C);
      return;
    case 'ObjectPattern':
      for (let i = 0; i < pattern.properties.length; i++) {
        const property = pattern.properties[i];
        forEachBindingIdentifier(property.type === 'RestElement' ? property.argument : property.value, visit, context as C);
      }
      return;
    case 'ArrayPattern':
      for (let i = 0; i < pattern.elements.length; i++) forEachBindingIdentifier(pattern.elements[i], visit, context as C);
      return;
    case 'RestElement':
      forEachBindingIdentifier(pattern.argument, visit, context as C);
      return;
    case 'AssignmentPattern':
      forEachBindingIdentifier(pattern.left, visit, context as C);
      return;
    default:
      return;
  }
}
