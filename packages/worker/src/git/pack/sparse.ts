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

/** Which paths a sparse worktree holds. */
export interface SparseMatcher {
  /** Whether the file (or symlink, or gitlink) at the repo-relative `path` is in the worktree. */
  includes(path: string): boolean;
  /** Whether the worktree holds the directory `dir` (something in the cone can be in it). */
  directory(dir: string): boolean;
}

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

/** The cone of `dirs`, as git's cone patterns match it. */
export function coneMatcher(dirs: readonly string[]): SparseMatcher {
  const recursive = new Set(normalizeDirs(dirs));
  const parents = parentsOf([...recursive]);
  const inRecursive = (dir: string) => {
    for (let at = dir.length; at > 0; at = dir.lastIndexOf('/', at - 1)) {
      if (recursive.has(dir.slice(0, at))) return true;
    }
    return false;
  };
  return {
    includes(path: string): boolean {
      const slash = path.lastIndexOf('/');
      if (slash < 0) return true;
      const dir = path.slice(0, slash);
      return parents.has(dir) || inRecursive(dir);
    },
    directory(dir: string): boolean {
      return dir === '' || parents.has(dir) || inRecursive(dir);
    },
  };
}

/**
 * The directories of a cone-mode info/sparse-checkout (as
 * coneSparseCheckout writes it, or git does): each "/<dir>/" not followed by
 * its "!/<dir>/*\/" is taken whole; null when the file is not cone-shaped.
 */
export function parseConeSparseCheckout(text: string): string[] | null {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  if (lines[0] !== '/*' || lines[1] !== '!/*/') return null;
  const unescape = (dir: string) => dir.replace(/\\(.)/g, '$1');
  const recursive: string[] = [];
  for (let i = 2; i < lines.length; i++) {
    const match = /^\/(.+)\/$/.exec(lines[i]);
    if (match === null) return null;
    if (lines[i + 1] === '!/' + match[1] + '/*/') {
      i++;
      continue;
    }
    recursive.push(unescape(match[1]));
  }
  return recursive;
}

/**
 * A boolean in git config text (config.c git_config_bool): the last
 * `<key>` in `[<section>]`, names compared without case; a key alone is
 * true; undefined when it is not set.
 */
export function configBoolean(text: string, section: string, key: string): boolean | undefined {
  let current = '';
  let value: boolean | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)[#;].*$/, '').trim();
    if (line === '') continue;
    const header = /^\[([^\]\s"]+)(?:\s+"[^"]*")?\]\s*(.*)$/.exec(line);
    if (header !== null) {
      current = header[1].toLowerCase();
      if (header[2] === '') continue;
    }
    const body = header !== null ? header[2] : line;
    if (current !== section.toLowerCase()) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(body);
    if (entry === null || entry[1].toLowerCase() !== key.toLowerCase()) continue;
    if (entry[2] === undefined) {
      value = true;
      continue;
    }
    const word = entry[2].replace(/^"(.*)"$/, '$1').toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(word)) value = true;
    else if (['false', 'no', 'off', '0', ''].includes(word)) value = false;
  }
  return value;
}

/** A directory as a cone pattern names it: glob characters and backslashes escaped (dir.c escape_pattern's set). */
function escapeDir(dir: string): string {
  return dir.replace(/[\\*?[]/g, (c) => '\\' + c);
}

/**
 * The info/sparse-checkout file of a cone (dir.c write_cone_to_file): the
 * top's files, then each parent directory's own files without its
 * subdirectories, then each recursive directory; parents and recursive
 * directories each in byte order, a recursive directory that is also a
 * parent listed as recursive only.
 */
export function coneSparseCheckout(dirs: readonly string[]): string {
  const recursive = normalizeDirs(dirs);
  const recursiveSet = new Set(recursive);
  // A parent below a recursive directory is in it already.
  const covered = (dir: string) => {
    for (let at = dir.lastIndexOf('/'); at > 0; at = dir.lastIndexOf('/', at - 1)) if (recursiveSet.has(dir.slice(0, at))) return true;
    return false;
  };
  const parents = [...parentsOf(recursive)].filter((dir) => !recursiveSet.has(dir) && !covered(dir));
  const kept = recursive.filter((dir) => !covered(dir));
  const encoder = new TextEncoder();
  const byBytes = (a: string, b: string) => {
    const x = encoder.encode(a);
    const y = encoder.encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  let text = '/*\n!/*/\n';
  for (const dir of parents.sort(byBytes)) text += '/' + escapeDir(dir) + '/\n!/' + escapeDir(dir) + '/*/\n';
  for (const dir of kept.sort(byBytes)) text += '/' + escapeDir(dir) + '/\n';
  return text;
}
