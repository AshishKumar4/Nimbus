/**
 * git/pack/sparse.ts — cone-mode sparse checkout (git sparse-checkout, cone
 * mode; dir.c's cone patterns): which paths a sparse worktree holds, and the
 * info/sparse-checkout file that says so.
 *
 * A cone is a set of directories taken whole ("recursive"). The worktree
 * holds every file at the top, every file below a recursive directory, and
 * the files directly in each recursive directory's parents; everything else
 * is in the index with skip-worktree set and not in the worktree. `git
 * clone --sparse` starts with no directories: the top's files only.
 */

const encoder = new TextEncoder();

/** Which paths a sparse worktree holds. */
export interface SparseMatcher {
  /** Whether the file (or symlink, or gitlink) at the repo-relative `path` is in the worktree. */
  includes(path: string): boolean;
  /** Whether the worktree holds the directory `dir` (something in the cone can be in it). */
  directory(dir: string): boolean;
}

/**
 * A cone as git holds one (dir.c's pattern list in cone mode): every path
 * (`full`), or the top's files, the files directly in each of `parents`, and
 * everything below each of `recursive`. Directories are repo-relative,
 * without leading or trailing slashes.
 */
export interface Cone {
  full: boolean;
  recursive: readonly string[];
  parents: readonly string[];
}

/** Every path: the cone `sparse-checkout disable` applies, and a file holding "/*" alone. */
export const FULL_CONE: Cone = { full: true, recursive: [], parents: [] };

/** A cone's directories: repo-relative, without leading or trailing slashes. */
function normalizeDirs(dirs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    const trimmed = dir.replace(/^\/+|\/+$/g, '');
    if (trimmed !== '') out.add(trimmed);
  }
  return [...out];
}

/** Every proper ancestor of each directory: the cone's parents. */
function parentsOf(dirs: readonly string[]): Set<string> {
  const parents = new Set<string>();
  for (const dir of dirs) {
    for (let at = dir.lastIndexOf('/'); at > 0; at = dir.lastIndexOf('/', at - 1)) parents.add(dir.slice(0, at));
  }
  return parents;
}

/** Strings in byte order (UTF-8), as git sorts the cone it writes. */
function byBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * The cone `git sparse-checkout set --cone <dirs>` makes (sparse-checkout.c
 * insert_recursive_pattern): each directory recursive and its ancestors
 * parents, but what a recursive directory already holds; each in byte order.
 */
export function coneOf(dirs: readonly string[]): Cone {
  const recursive = normalizeDirs(dirs);
  const recursiveSet = new Set(recursive);
  // A directory below a recursive one is in it already.
  const covered = (dir: string) => {
    for (let at = dir.lastIndexOf('/'); at > 0; at = dir.lastIndexOf('/', at - 1)) if (recursiveSet.has(dir.slice(0, at))) return true;
    return false;
  };
  return {
    full: false,
    recursive: recursive.filter((dir) => !covered(dir)).sort(byBytes),
    parents: [...parentsOf(recursive)].filter((dir) => !recursiveSet.has(dir) && !covered(dir)).sort(byBytes),
  };
}

/** fspathcmp's folding under core.ignoreCase: ASCII letters in lower case, other bytes as they are. */
function foldCase(path: string): string {
  return path.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/**
 * Which paths `cone` holds, as path_matches_pattern_list matches cone
 * patterns: a file at the top, one whose path is a recursive directory's,
 * one directly in a parent, one below a recursive directory. Under
 * core.ignoreCase (`ignoreCase`) paths compare as fspathcmp compares them.
 */
export function coneMatcher(cone: Cone, ignoreCase = false): SparseMatcher {
  if (cone.full) return { includes: () => true, directory: () => true };
  const fold = ignoreCase ? foldCase : (path: string) => path;
  const recursive = new Set(cone.recursive.map(fold));
  const parents = new Set(cone.parents.map(fold));
  // The directories something in the cone is below: a parent, and the ancestors of a parent or a recursive directory.
  const holding = new Set([...parents, ...parentsOf([...recursive, ...parents])]);
  const inRecursive = (dir: string) => {
    for (let at = dir.length; at > 0; at = dir.lastIndexOf('/', at - 1)) {
      if (recursive.has(dir.slice(0, at))) return true;
    }
    return false;
  };
  return {
    includes(path: string): boolean {
      const key = fold(path);
      if (recursive.has(key)) return true;
      const slash = key.lastIndexOf('/');
      if (slash < 0) return true;
      const dir = key.slice(0, slash);
      return parents.has(dir) || inRecursive(dir);
    },
    directory(dir: string): boolean {
      const key = fold(dir);
      return key === '' || holding.has(key) || inRecursive(key);
    },
  };
}

/** is_glob_special: the characters a cone pattern escapes. */
const GLOB_SPECIAL = new Set(['*', '?', '[', '\\']);

/** trim_trailing_spaces: trailing spaces go, but one escaped by a backslash. */
function trimTrailingSpaces(line: string): string {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') {
      if (lastSpace < 0) lastSpace = i;
    } else if (line[i] === '\\') {
      if (++i === line.length) return line;
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace);
}

/** dup_and_filter_pattern: each backslash dropped once, the character after it kept. */
function unescapePattern(pattern: string): string {
  return pattern.replace(/\\(.?)/g, '$1');
}

/**
 * The cone of a cone-mode info/sparse-checkout, read line by line as dir.c
 * add_pattern_to_hashsets reads it: "/*" alone makes the full cone and
 * "!/*\/" takes it back; "/<dir>/" adds a recursive directory, and
 * "!/<dir>/*\/" after it makes that a parent. null when a line is not a cone
 * pattern (where git warns and gives up cone mode).
 */
export function parseConeSparseCheckout(text: string): Cone | null {
  let full = false;
  const recursive = new Set<string>();
  const parents = new Set<string>();
  // add_patterns_from_buffer: a UTF-8 BOM skipped, lines to each newline (CR LF as LF), empty ones and comments skipped.
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  if (!text.endsWith('\n')) lines.push('');
  for (const raw of lines.slice(0, -1)) {
    if (raw === '' || raw.startsWith('#')) continue;
    // parse_path_pattern: a leading "!" negates, a trailing "/" says directory.
    let pattern = trimTrailingSpaces(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    const negative = pattern.startsWith('!');
    if (negative) pattern = pattern.slice(1);
    const mustBeDir = pattern.endsWith('/');
    if (mustBeDir) pattern = pattern.slice(0, -1);
    if (pattern === '/*' && negative && mustBeDir) {
      full = false;
      continue;
    }
    if (pattern === '/*' && !negative && !mustBeDir) {
      full = true;
      continue;
    }
    if (pattern.length < 2 || pattern[0] !== '/' || pattern.includes('**') || !mustBeDir) return null;
    // A glob character only escaped, but a trailing "/*".
    for (let i = 1; i < pattern.length; i++) {
      const c = pattern[i];
      if (!GLOB_SPECIAL.has(c) || pattern[i - 1] === '\\') continue;
      if (c === '\\' && GLOB_SPECIAL.has(pattern[i + 1] ?? '')) continue;
      if (pattern[i - 1] === '/' && c === '*' && i === pattern.length - 1) continue;
      return null;
    }
    if (pattern.length > 2 && pattern.endsWith('/*')) {
      // "!/<dir>/*/": <dir>, recursive until now, is a parent.
      const dir = unescapePattern(pattern.slice(1, -2));
      if (!negative || !recursive.has(dir)) return null;
      recursive.delete(dir);
      parents.add(dir);
      continue;
    }
    if (negative) return null;
    const dir = unescapePattern(pattern.slice(1));
    if (parents.has(dir)) return null;
    recursive.add(dir);
  }
  return { full, recursive: [...recursive], parents: [...parents] };
}

/** A directory as a cone pattern names it: glob characters and backslashes escaped (dir.c escape_pattern's set). */
function escapeDir(dir: string): string {
  return dir.replace(/[\\*?[]/g, (c) => '\\' + c);
}

/**
 * The info/sparse-checkout file of a cone (dir.c write_cone_to_file): the
 * top's files, then each parent directory's own files without its
 * subdirectories, then each recursive directory, in coneOf's order.
 */
export function coneSparseCheckout(dirs: readonly string[]): string {
  const { recursive, parents } = coneOf(dirs);
  let text = '/*\n!/*/\n';
  for (const dir of parents) text += '/' + escapeDir(dir) + '/\n!/' + escapeDir(dir) + '/*/\n';
  for (const dir of recursive) text += '/' + escapeDir(dir) + '/\n';
  return text;
}
