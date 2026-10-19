/**
 * The namespace's read path: the row at a key, and the walk of a name to
 * where the table holds it. Module loading reads every file through these
 * (node-shims _nsWalk, _entry), after the program may have replaced any
 * built-in, so they call only the launch's captures (core _shared
 * primordials.ts; design-guest-loader-primordials.md §3.5), as Node's loader
 * reads files on its primordials.
 */
import {
  arrayIsArray, arrayJoin, objectHasOwn, ownField, SafeList, type SafeSet, stringCharCodeAt, stringIndexOf, stringLastIndexOf, stringOf, stringSlice,
} from '@nimbus-sh/core/_shared/primordials.js';
import { NS_DIR, NS_LINK, type NsRow, type ResidentTables } from './tables.js';

/** Symlink hops before a resolution is ELOOP, as Linux's MAXSYMLINKS. */
export const NS_MAX_HOPS = 40;

/**
 * What the process's own effects say of a name, ahead of the table (the
 * shims' overlay): it removed it (`absent`); it made a symlink there
 * (`target`); it renamed the table's entry at `from` to it (`from` undefined:
 * a moved link that resolves to nothing; `link`: the moved entry is a symlink,
 * whose own row is at that key; `ino`, `dev`: the entry moved; `via`: names
 * an earlier rename of it, not yet landed, left it under); or it made a
 * directory or file there (`made`; `hide`: rows the table holds beneath it
 * are not this directory's).
 */
export type OwnWord =
  | { readonly absent: true }
  | { readonly target: string }
  | { readonly from: string | undefined; readonly link?: string; readonly ino?: number; readonly dev?: number; readonly via?: readonly string[] }
  | { readonly made: 'directory' | 'file'; readonly hide?: boolean };
/** The process's word on a name (by the name the walk reached), or undefined. */
export type OwnView = (k: string) => OwnWord | undefined;

/**
 * Where a walk lands: the name reached (the process's own naming, links
 * followed), where the table holds it (`table`, null where no row of the
 * table's can be: under a directory the process made, or at its own entry),
 * the table's row there, and the process's own word on the name.
 */
export interface Lookup { path: string; table: string | null; row: NsRow | undefined; own?: OwnWord }

// What an own word says, by its own properties: never one it inherits.
const removed = (word: OwnWord): word is { readonly absent: true } => objectHasOwn(word, 'absent');
const linked = (word: OwnWord): word is { readonly target: string } => objectHasOwn(word, 'target');
const moved = (word: OwnWord): word is { readonly from: string | undefined; readonly link?: string } => objectHasOwn(word, 'from');

/**
 * A rename's word, as the table now holds the entry it moved. A barrier can
 * carry the rename (or an earlier one of the entry, `via`) to the table
 * before the word retires: the word stands while the table holds the entry
 * where the word reads it (a link's own row at `link`, else at `from`); once
 * the name holds it (at `step`, where the table keeps the name the walk
 * reached, an outer rename's mapping applied), the table's row there
 * answers; where an earlier rename left it, the word reads it there. A word
 * that names no entry stands.
 */
function standing(t: ResidentTables, step: string | null, word: OwnWord | undefined): OwnWord | undefined {
  if (word === undefined || !moved(word) || word.from === undefined) return word;
  const ino = ownField(word, 'ino');
  if (typeof ino !== 'number') return word;
  const dev = ownField(word, 'dev');
  const named = ownField(word, 'link');
  const link = typeof named === 'string' ? named : undefined;
  const holds = (k: string): boolean => {
    const row = nsRowAt(t, k);
    return row !== undefined && row.ino === ino && (typeof dev !== 'number' || row.dev === dev);
  };
  if (holds(link ?? word.from)) return word;
  if (step !== null && holds(step)) return undefined;
  const via = ownField(word, 'via');
  if (arrayIsArray(via)) {
    for (let i = 0; i < via.length; i++) {
      const at = stringOf(via[i]);
      if (holds(at)) return link === undefined ? { from: at } : { from: word.from, link: at };
    }
  }
  return word;
}

/** The directory part of key `k`: '' at the top. */
export function nsParent(k: string): string {
  const i = stringLastIndexOf(k, '/');
  return i < 0 ? '' : stringSlice(k, 0, i);
}

/** The last name of key `k`. */
export function nsName(k: string): string {
  return stringSlice(k, stringLastIndexOf(k, '/') + 1);
}

/** Key `k` as its directory and its last name. */
export function nsSplit(k: string): [string, string] {
  return [nsParent(k), nsName(k)];
}

/** A path as the namespace keys it: no leading '/'. */
export function nsKey(path: unknown): string {
  const text = stringOf(path);
  let at = 0;
  while (at < text.length && stringCharCodeAt(text, at) === 0x2f) at++;
  return at === 0 ? text : stringSlice(text, at);
}

/** The row at exactly `k` (no symlink resolution), or undefined. */
export function nsRowAt(t: ResidentTables, k: string): NsRow | undefined {
  if (k === '') {
    return { kind: NS_DIR, size: 0, mode: 0o40755, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino: 1, rev: 0, target: null, dev: 0, nlink: 1 };
  }
  const i = stringLastIndexOf(k, '/');
  return i < 0 ? t.nsGet('', k) : t.nsGet(stringSlice(k, 0, i), stringSlice(k, i + 1));
}

/**
 * A link's `target` resolved lexically against the directory of the name it
 * was reached by (`linkPath`): its names after that directory's, an absolute
 * target's from the top, `.` and empty names dropped, each `..` taking back
 * the name before it and staying at the top (platform lexical-path's
 * rootClampedSegments).
 */
export function joinTarget(linkPath: string, target: unknown): string {
  const text = stringOf(target);
  const out = new SafeList<string>();
  // Each name of `path`, as `reduce` takes it: '..' and '.' reduced, or kept as they are.
  const names = (path: string, reduce: boolean): void => {
    for (let start = 0; start <= path.length;) {
      let stop = stringIndexOf(path, '/', start);
      if (stop < 0) stop = path.length;
      const name = stringSlice(path, start, stop);
      start = stop + 1;
      if (name === '') continue;
      if (reduce && name === '..') {
        if (out.length > 0) out.length--;
      } else if (!reduce || name !== '.') out[out.length] = name;
    }
  };
  // The link's directory, its names as they are.
  if (stringCharCodeAt(text, 0) !== 0x2f) names(nsParent(linkPath), false);
  names(text, true);
  return arrayJoin(out, '/');
}

/**
 * The walk of `k` (lookup): the process's own effects (`own`) applied at
 * each name it reaches, ahead of the table: a name it removed ends the walk,
 * its links and renames redirect it, and beneath a directory it made only
 * its own names are there. The leaf is followed only when `followLeaf`. A
 * link's target is joined to the name it was reached by. `visit`: told each
 * name the walk looks up, in order; false stops the walk there, EACCES.
 */
export function walkNamespace(
  t: ResidentTables,
  links: SafeSet<string>,
  k: string,
  followLeaf: boolean,
  own: OwnView | undefined,
  visit: ((name: string) => boolean) | undefined,
): Lookup | 'ELOOP' | 'EACCES' {
  if (own === undefined && links.size === 0 && visit === undefined) return { path: k, table: k, row: nsRowAt(t, k) };
  let path = k;
  walk: for (let hops = 0; hops <= NS_MAX_HOPS; hops++) {
    let table: string | null = '';
    // Each name of the path in turn: its prefix is the path up to it, the
    // rest what follows it (empty names kept, as a walk's steps).
    for (let start = 0, more = path !== ''; more;) {
      let stop = stringIndexOf(path, '/', start);
      const leaf = stop < 0;
      if (leaf) stop = path.length;
      const name = stringSlice(path, start, stop);
      const prefix = stringSlice(path, 0, stop);
      more = !leaf;
      start = stop + 1;
      if (visit !== undefined && !visit(prefix)) return 'EACCES';
      const step: string | null = table === null ? null : table ? `${table}/${name}` : name;
      const word: OwnWord | undefined = own === undefined ? undefined : standing(t, step, own(prefix));
      let target: unknown;
      if (word !== undefined && removed(word)) {
        return { path, table: null, row: undefined, own: word };
      } else if (word !== undefined && linked(word)) {
        if (leaf && !followLeaf) return { path, table: null, row: undefined, own: word };
        target = word.target;
      } else if (word !== undefined && moved(word)) {
        const named = ownField(word, 'link');
        const link = typeof named === 'string' ? named : undefined;
        if (link !== undefined && leaf && !followLeaf) {
          const at = nsRowAt(t, link) !== undefined ? link : prefix;
          return { path, table: at, row: nsRowAt(t, at), own: word };
        }
        if (word.from === undefined) return { path, table: null, row: undefined, own: { absent: true } };
        if (link !== undefined) target = `/${word.from}`;
        else {
          table = word.from;
          if (leaf) return { path, table, row: nsRowAt(t, table), own: word };
          continue;
        }
      } else if (word !== undefined) {
        // Its own entry is where the table will hold it.
        table = ownField(word, 'hide') === true ? null : prefix;
        if (leaf) return { path, table: prefix, row: nsRowAt(t, prefix), own: word };
        continue;
      } else {
        if (step === null) return { path, table: null, row: undefined };
        table = step;
        if (!links.has(step) || (leaf && !followLeaf)) continue;
        const row = nsRowAt(t, step);
        if (!row || row.kind !== NS_LINK) continue;
        target = row.target;
      }
      const rest = leaf ? '' : stringSlice(path, stop + 1);
      const reached = joinTarget(prefix, target);
      path = rest ? (reached ? `${reached}/${rest}` : rest) : reached;
      continue walk;
    }
    return { path, table, row: table === null ? undefined : nsRowAt(t, table) };
  }
  return 'ELOOP';
}
