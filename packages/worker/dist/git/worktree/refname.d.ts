/**
 * A ref's name as git checks it: refs.c check_refname_format with no flags
 * (git-check-ref-format(1)). Each '/'-separated component is non-empty, does
 * not begin with '.', holds no '..', no '@{', no control character, space,
 * '~', '^', ':', '?', '*', '[' or '\', and does not end with '.lock'; the
 * name does not end with '.' and is not '@'. Bytes past ASCII are allowed.
 */
export declare function isValidRefName(name: string): boolean;
//# sourceMappingURL=refname.d.ts.map