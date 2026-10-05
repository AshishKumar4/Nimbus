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
import { WM_CASEFOLD, WM_PATHNAME, wildmatch } from './wildmatch.js';
const NEGATIVE = 1;
const MUSTBEDIR = 2;
const NODIR = 4;
const ENDSWITH = 8;
const SLASH = 0x2f;
const encoder = new TextEncoder();
/** simple_length: bytes before the first of `*?[\`. */
function simpleLength(bytes, from = 0, to = bytes.length) {
    for (let i = from; i < to; i++) {
        const c = bytes[i];
        if (c === 0x2a || c === 0x3f || c === 0x5b || c === 0x5c)
            return i - from;
    }
    return to - from;
}
/** trim_trailing_spaces: unescaped trailing spaces go; an escaped one stays. */
function trimTrailingSpaces(line) {
    let lastSpace = -1;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === 0x20) {
            if (lastSpace < 0)
                lastSpace = i;
        }
        else if (line[i] === 0x5c) {
            if (++i >= line.length)
                return line;
            lastSpace = -1;
        }
        else {
            lastSpace = -1;
        }
    }
    return lastSpace < 0 ? line : line.subarray(0, lastSpace);
}
/** add_pattern / parse_path_pattern for one line. */
function parsePattern(line, base) {
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
    if (p.subarray(0, length).indexOf(SLASH) < 0)
        flags |= NODIR;
    const nowildcard = Math.min(simpleLength(p), length);
    if (p[0] === 0x2a && simpleLength(p, 1) === p.length - 1)
        flags |= ENDSWITH;
    return { pattern: p.slice(0, length), nowildcard, flags, base };
}
/**
 * add_patterns_from_buffer: a pattern file's lines, `base` the repo-relative
 * directory the file sits in ('' at the top). A UTF-8 BOM, blank lines and
 * `#` comments are skipped; a CR before the LF is dropped.
 */
export function parsePatternList(bytes, base) {
    const baseBytes = encoder.encode(base ? `${base}/` : '');
    let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const list = [];
    // The file reads as if it ended in a newline, as git appends one.
    for (let i = start; i <= bytes.length; i++) {
        if (i < bytes.length && bytes[i] !== 0x0a)
            continue;
        if (i !== start && bytes[start] !== 0x23) {
            const end = i > start && bytes[i - 1] === 0x0d ? i - 1 : i;
            list.push(parsePattern(trimTrailingSpaces(bytes.subarray(start, end)), baseBytes));
        }
        start = i + 1;
    }
    return list;
}
/** fspathncmp: bytes equal, ASCII letters either case under core.ignorecase. */
function equalBytes(a, aFrom, b, bFrom, length, fold) {
    for (let i = 0; i < length; i++) {
        let x = a[aFrom + i];
        let y = b[bFrom + i];
        if (fold) {
            if (x >= 0x41 && x <= 0x5a)
                x += 0x20;
            if (y >= 0x41 && y <= 0x5a)
                y += 0x20;
        }
        if (x !== y)
            return false;
    }
    return true;
}
/** match_basename. */
function matchBasename(path, basename, p, fold) {
    const length = path.length - basename;
    const { pattern } = p;
    if (p.nowildcard === pattern.length) {
        return pattern.length === length && equalBytes(pattern, 0, path, basename, length, fold);
    }
    if (p.flags & ENDSWITH) {
        return pattern.length - 1 <= length && equalBytes(pattern, 1, path, path.length - (pattern.length - 1), pattern.length - 1, fold);
    }
    return wildmatch(pattern, path.subarray(basename), fold ? WM_CASEFOLD : 0);
}
/** match_pathname: the pattern, anchored at its file's directory, against the whole path. */
function matchPathname(path, p, fold) {
    let pattern = p.pattern;
    let prefix = p.nowildcard;
    if (pattern[0] === SLASH) {
        pattern = pattern.subarray(1);
        prefix--;
    }
    const baseLength = p.base.length ? p.base.length - 1 : 0;
    if (path.length < baseLength + 1 || (baseLength && path[baseLength] !== SLASH) || !equalBytes(path, 0, p.base, 0, baseLength, fold)) {
        return false;
    }
    let name = path.subarray(baseLength ? baseLength + 1 : 0);
    if (prefix) {
        if (prefix > name.length || !equalBytes(pattern, 0, name, 0, prefix, fold))
            return false;
        if (pattern.length === prefix && name.length === prefix)
            return true;
        // One byte of the prefix stays, so wildmatch sees where a component starts.
        prefix--;
        pattern = pattern.subarray(prefix);
        name = name.subarray(prefix);
    }
    return wildmatch(pattern, name, WM_PATHNAME | (fold ? WM_CASEFOLD : 0));
}
/** last_matching_pattern_from_list: the list's last pattern that matches, or null. */
function lastMatching(list, path, basename, isDir, fold) {
    for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if ((p.flags & MUSTBEDIR) && !isDir)
            continue;
        if (p.flags & NODIR ? matchBasename(path, basename, p, fold) : matchPathname(path, p, fold))
            return p;
    }
    return null;
}
/**
 * The exclude rules of one worktree. `readGitignore(dir)` answers the bytes
 * of `<dir>/.gitignore` (dir repo-relative, '' the top), or null when there
 * is none. `fileLists` are core.excludesFile's patterns then info/exclude's;
 * the later one wins, as git checks info/exclude first. `ignoreCase` is
 * core.ignorecase: letters match either case.
 */
export class Excludes {
    readGitignore;
    fileLists;
    ignoreCase;
    stack = [];
    constructor(readGitignore, fileLists, ignoreCase = false) {
        this.readGitignore = readGitignore;
        this.fileLists = fileLists;
        this.ignoreCase = ignoreCase;
    }
    /** is_excluded: whether git ignores `path` (repo-relative), a directory when `isDir`. */
    async isExcluded(path, isDir) {
        const cut = path.lastIndexOf('/');
        const top = await this.levelFor(cut < 0 ? '' : path.slice(0, cut));
        if (top.excluded)
            return true;
        const bytes = encoder.encode(path);
        const match = this.lastMatchingInLists(bytes, bytes.lastIndexOf(SLASH) + 1, isDir);
        return match !== null && !(match.flags & NEGATIVE);
    }
    lastMatchingInLists(path, basename, isDir) {
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const list = this.stack[i].list;
            const match = list && lastMatching(list, path, basename, isDir, this.ignoreCase);
            if (match)
                return match;
        }
        for (let i = this.fileLists.length - 1; i >= 0; i--) {
            const match = lastMatching(this.fileLists[i], path, basename, isDir, this.ignoreCase);
            if (match)
                return match;
        }
        return null;
    }
    /** prep_exclude: the stack along `dir`'s ancestors and `dir` itself, the lists that apply in it. */
    async levelFor(dir) {
        const wanted = dir ? ['', ...dir.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))] : [''];
        let keep = 0;
        while (keep < this.stack.length && keep < wanted.length && this.stack[keep].dir === wanted[keep])
            keep++;
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
