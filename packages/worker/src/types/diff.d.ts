/**
 * The one jsdiff entry point the git command uses. diff@5 ships no types and
 * the repo carries no @types/diff.
 */
declare module 'diff' {
  export interface ArrayChange<T> {
    value: T[];
    count?: number;
    added?: boolean;
    removed?: boolean;
  }
  /** Myers diff of two arrays; undefined once the edit script would exceed `maxEditLength`. */
  export function diffArrays<T>(
    oldArr: T[],
    newArr: T[],
    options?: { maxEditLength?: number },
  ): ArrayChange<T>[] | undefined;
}
