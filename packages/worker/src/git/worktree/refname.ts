/**
 * A ref's name as git checks it: refs.c check_refname_format with no flags
 * (git-check-ref-format(1)). Each '/'-separated component is non-empty, does
 * not begin with '.', holds no '..', no '@{', no control character, space,
 * '~', '^', ':', '?', '*', '[' or '\', and does not end with '.lock'; the
 * name does not end with '.' and is not '@'. Bytes past ASCII are allowed.
 */

/** Characters no component may hold: control characters and DEL, space, and ~ ^ : ? * [ \ */
const FORBIDDEN = /[\x00-\x20\x7f~^:?*[\\]/;

export function isValidRefName(name: string): boolean {
  if (name === '@' || name.endsWith('.')) return false;
  for (const component of name.split('/')) {
    if (component.length === 0 || component.startsWith('.') || component.endsWith('.lock')) return false;
    if (component.includes('..') || component.includes('@{') || FORBIDDEN.test(component)) return false;
  }
  return true;
}
