/**
 * git/worktree/excludes.ts — which untracked paths git ignores (dir.c).
 *
 * The rules are git's: a .gitignore's patterns apply below its directory,
 * the deepest list with a matching pattern decides (its last matching
 * pattern, a `!` one re-including), then $GIT_DIR/info/exclude, then
 * core.excludesFile. A directory that is itself excluded excludes all that
 * is below it, and its own .gitignore is never read (prep_exclude). Lists
 * load only for the directories a check reaches, one stack along the path
 * being checked, so a walk holds the lists of one branch of the tree.
 */

import { WM_PATHNAME, wildmatch } from './wildmatch.js';

const NEGATIVE = 1;
const MUSTBEDIR = 2;
const NODIR = 4;
const ENDSWITH = 8;

const SLASH = 0x2f;
const encoder = new TextEncoder();

interface PathPattern {
  /** The pattern without its `!` and its trailing '/'. */
  pattern: Uint8Array;
  /** Bytes before the first glob character. */
  nowildcard: number;
  flags: number;
  /** The directory of the file the pattern came from, '' or ending in '/'. */
  base: Uint8Array;
}

/** One file's patterns, in the order the file gives them. */
export type PatternList = PathPattern[];

/** simple_length: bytes before the first of `*?[\`. */
function simpleLength(bytes: Uint8Array, from = 0, to = bytes.length): number {
  for (let i = from; i < to; i++) {
    const c = bytes[i];
    if (c === 0x2a || c === 0x3f || c === 0x5b || c === 0x5c) return i - from;
  }
  return to - from;
}

/** trim_trailing_spaces: unescaped trailing spaces go; an escaped one stays. */
function trimTrailingSpaces(line: Uint8Array): Uint8Array {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === 0x20) {
      if (lastSpace < 0) lastSpace = i;
    } else if (line[i] === 0x5c) {
      if (++i >= line.length) return line;
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? line : line.subarray(0, lastSpace);
}

/** add_pattern / parse_path_pattern for one line. */
function parsePattern(line: Uint8Array, base: Uint8Array): PathPattern {
  let flags = 0;
  let p = line;
  if (p[0] === 0x21) {
    flags |= NEGATIVE;
    p = p.subarray(1);
  }
  let length = p.length;
  if (length && p[length - 1] === SLASH) {
    length--;
    flags |= MUSTBEDIR;
  }
  if (p.subarray(0, length).indexOf(SLASH) < 0) flags |= NODIR;
  const nowildcard = Math.min(simpleLength(p), length);
  if (p[0] === 0x2a && simpleLength(p, 1) === p.length - 1) flags |= ENDSWITH;
  return { pattern: p.slice(0, length), nowildcard, flags, base };
}

/**
 * add_patterns_from_buffer: a pattern file's lines, `base` the repo-relative
 * directory the file sits in ('' at the top). A UTF-8 BOM, blank lines and
 * `#` comments are skipped; a CR before the LF is dropped.
 */
export function parsePatternList(bytes: Uint8Array, base: string): PatternList {
  const baseBytes = encoder.encode(base ? `${base}/` : '');
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const list: PatternList = [];
  // The file reads as if it ended in a newline, as git appends one.
  for (let i = start; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue;
    if (i !== start && bytes[start] !== 0x23) {
      const end = i > start && bytes[i - 1] === 0x0d ? i - 1 : i;
      list.push(parsePattern(trimTrailingSpaces(bytes.subarray(start, end)), baseBytes));
    }
    start = i + 1;
  }
  return list;
}

function equalBytes(a: Uint8Array, aFrom: number, b: Uint8Array, bFrom: number, length: number): boolean {
  for (let i = 0; i < length; i++) if (a[aFrom + i] !== b[bFrom + i]) return false;
  return true;
}

/** match_basename. */
function matchBasename(path: Uint8Array, basename: number, p: PathPattern): boolean {
  const length = path.length - basename;
  const { pattern } = p;
  if (p.nowildcard === pattern.length) {
    return pattern.length === length && equalBytes(pattern, 0, path, basename, length);
  }
  if (p.flags & ENDSWITH) {
    return pattern.length - 1 <= length && equalBytes(pattern, 1, path, path.length - (pattern.length - 1), pattern.length - 1);
  }
  return wildmatch(pattern, path.subarray(basename));
}

/** match_pathname: the pattern, anchored at its file's directory, against the whole path. */
function matchPathname(path: Uint8Array, p: PathPattern): boolean {
  let pattern = p.pattern;
  let prefix = p.nowildcard;
  if (pattern[0] === SLASH) {
    pattern = pattern.subarray(1);
    prefix--;
  }
  const baseLength = p.base.length ? p.base.length - 1 : 0;
  if (path.length < baseLength + 1 || (baseLength && path[baseLength] !== SLASH) || !equalBytes(path, 0, p.base, 0, baseLength)) {
    return false;
  }
  let name = path.subarray(baseLength ? baseLength + 1 : 0);
  if (prefix) {
    if (prefix > name.length || !equalBytes(pattern, 0, name, 0, prefix)) return false;
    if (pattern.length === prefix && name.length === prefix) return true;
    // One byte of the prefix stays, so wildmatch sees where a component starts.
    prefix--;
    pattern = pattern.subarray(prefix);
    name = name.subarray(prefix);
  }
  return wildmatch(pattern, name, WM_PATHNAME);
}

/** last_matching_pattern_from_list: the list's last pattern that matches, or null. */
function lastMatching(list: PatternList, path: Uint8Array, basename: number, isDir: boolean): PathPattern | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if ((p.flags & MUSTBEDIR) && !isDir) continue;
    if (p.flags & NODIR ? matchBasename(path, basename, p) : matchPathname(path, p)) return p;
  }
  return null;
}

interface Level {
  /** Repo-relative directory, '' at the top. */
  dir: string;
  /** Excluded itself, or below an excluded directory: everything in it is. */
  excluded: boolean;
  /** Its .gitignore, when it has one and is not excluded. */
  list: PatternList | null;
}

/**
 * The exclude rules of one worktree. `readGitignore(dir)` answers the bytes
 * of `<dir>/.gitignore` (dir repo-relative, '' the top), or null when there
 * is none. `fileLists` are core.excludesFile's patterns then info/exclude's;
 * the later one wins, as git checks info/exclude first.
 */
export class Excludes {
  private readonly stack: Level[] = [];

  constructor(
    private readonly readGitignore: (dir: string) => Promise<Uint8Array | null>,
    private readonly fileLists: readonly PatternList[],
  ) {}

  /** is_excluded: whether git ignores `path` (repo-relative), a directory when `isDir`. */
  async isExcluded(path: string, isDir: boolean): Promise<boolean> {
    const cut = path.lastIndexOf('/');
    const top = await this.levelFor(cut < 0 ? '' : path.slice(0, cut));
    if (top.excluded) return true;
    const bytes = encoder.encode(path);
    const match = this.lastMatchingInLists(bytes, bytes.lastIndexOf(SLASH) + 1, isDir);
    return match !== null && !(match.flags & NEGATIVE);
  }

  private lastMatchingInLists(path: Uint8Array, basename: number, isDir: boolean): PathPattern | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const list = this.stack[i].list;
      const match = list && lastMatching(list, path, basename, isDir);
      if (match) return match;
    }
    for (let i = this.fileLists.length - 1; i >= 0; i--) {
      const match = lastMatching(this.fileLists[i], path, basename, isDir);
      if (match) return match;
    }
    return null;
  }

  /** prep_exclude: the stack along `dir`'s ancestors and `dir` itself, the lists that apply in it. */
  private async levelFor(dir: string): Promise<Level> {
    const wanted = dir ? ['', ...dir.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))] : [''];
    let keep = 0;
    while (keep < this.stack.length && keep < wanted.length && this.stack[keep].dir === wanted[keep]) keep++;
    this.stack.length = keep;
    for (let i = keep; i < wanted.length; i++) {
      const parent = this.stack[i - 1];
      let excluded = parent?.excluded ?? false;
      if (parent && !excluded) {
        const bytes = encoder.encode(wanted[i]);
        const match = this.lastMatchingInLists(bytes, bytes.lastIndexOf(SLASH) + 1, true);
        excluded = match !== null && !(match.flags & NEGATIVE);
      }
      const text = excluded ? null : await this.readGitignore(wanted[i]);
      this.stack.push({ dir: wanted[i], excluded, list: text === null ? null : parsePatternList(text, wanted[i]) });
    }
    return this.stack[this.stack.length - 1];
  }
}
