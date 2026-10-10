/**
 * binding-pattern.ts — the identifiers a binding pattern binds, in source
 * order: an identifier, and what the parts of an object or array pattern, a
 * rest element and a default bind. A member expression is an assignment
 * target, not a binding, and an array hole binds nothing.
 *
 * Reads only ESTree's fields, so it serves acorn's trees, rolldown's and the
 * interpreter's own copies alike; callers differ only in what they do with
 * the identifiers. The interpreter runs it after a program may have replaced
 * built-ins, so it names none (tests/unit/interpreter-primordials.mjs).
 */
import type { Identifier, Pattern } from 'acorn';

/**
 * Appends to `out` each identifier `pattern` binds; answers `out`. It
 * appends by index, so an interpreter SafeList serves as well as an array.
 */
export function bindingIdentifiers<L extends { length: number; [index: number]: Identifier }>(pattern: Pattern | null, out: L): L {
  if (pattern === null) return out;
  switch (pattern.type) {
    case 'Identifier':
      out[out.length] = pattern;
      return out;
    case 'ObjectPattern':
      for (let i = 0; i < pattern.properties.length; i++) {
        const property = pattern.properties[i];
        bindingIdentifiers(property.type === 'RestElement' ? property.argument : property.value, out);
      }
      return out;
    case 'ArrayPattern':
      for (let i = 0; i < pattern.elements.length; i++) bindingIdentifiers(pattern.elements[i], out);
      return out;
    case 'RestElement':
      return bindingIdentifiers(pattern.argument, out);
    case 'AssignmentPattern':
      return bindingIdentifiers(pattern.left, out);
    default:
      return out;
  }
}
