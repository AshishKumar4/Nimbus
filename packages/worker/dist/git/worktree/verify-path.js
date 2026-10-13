/**
 * git/worktree/verify-path.ts — the paths git lets into its index and
 * worktree (read-cache.c verify_path, path.c is_ntfs_dotgit, utf8.c
 * is_hfs_dotgit).
 *
 * No component may be empty, `.` or `..`, or `.git` in any case, and a link
 * may not be `.gitmodules`. With core.protectNTFS (on unless configured off)
 * neither may a name NTFS reads as one of those: trailing spaces and periods,
 * the short names (`git~1`), an alternate stream (`.git::$INDEX_ALLOCATION`),
 * a backslash as a separator. With core.protectHFS (off unless configured on,
 * as git builds it off macOS) neither may a name HFS+ reads as one, with the
 * code points it ignores.
 */
/** git's defaults off macOS and Windows. */
export const DEFAULT_PATH_PROTECTION = { hfs: false, ntfs: true };
/** git's error for a path verify_path refuses (add_index_entry_with_check, make_cache_entry). */
export const invalidPathError = (path) => `error: invalid path '${path}'\n`;
const DOT = 0x2e;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const SPACE = 0x20;
const TILDE = 0x7e;
/** The code unit at `i`, 0 past the end (the C string's NUL). */
const at = (path, i) => (i < path.length ? path.charCodeAt(i) : 0);
const lower = (c) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
/** `word` (lowercase ASCII) at `i`, in any case (strncasecmp). */
function iprefix(path, i, word) {
    for (let k = 0; k < word.length; k++)
        if (lower(at(path, i + k)) !== word.charCodeAt(k))
            return false;
    return true;
}
/** verify_dotfile: the component whose leading '.' is before `i`. */
function dotfileAllowed(path, i, link) {
    const c = at(path, i);
    if (c === 0 || c === SLASH)
        return false;
    if (iprefix(path, i, 'git')) {
        const next = at(path, i + 3);
        if (next === 0 || next === SLASH)
            return false;
        if (link && iprefix(path, i + 3, 'modules')) {
            const after = at(path, i + 10);
            if (after === 0 || after === SLASH)
                return false;
        }
    }
    else if (c === DOT) {
        const next = at(path, i + 1);
        if (next === 0 || next === SLASH)
            return false;
    }
    return true;
}
function onlySpacesAndPeriods(path, i) {
    for (;;) {
        const c = at(path, i++);
        if (c === 0 || c === COLON)
            return true;
        if (c !== SPACE && c !== DOT)
            return false;
    }
}
/** is_ntfs_dotgit: `.git` or `git~1` at `i`, then only spaces and periods to the component's end or a stream. */
function isNtfsDotgit(path, i) {
    if (at(path, i) === DOT) {
        if (!iprefix(path, i + 1, 'git'))
            return false;
        i += 4;
    }
    else {
        if (!iprefix(path, i, 'git') || at(path, i + 3) !== TILDE || at(path, i + 4) !== 0x31)
            return false;
        i += 5;
    }
    for (;;) {
        const c = at(path, i++);
        if (c === 0 || c === SLASH || c === BACKSLASH || c === COLON)
            return true;
        if (c !== DOT && c !== SPACE)
            return false;
    }
}
/** is_ntfs_dotgitmodules (is_ntfs_dot_generic): `.gitmodules`, its short name `gitmod~N`, or its hashed one `gi7eba~N`. */
function isNtfsDotgitmodules(path, i) {
    if (at(path, i) === DOT && iprefix(path, i + 1, 'gitmodules'))
        return onlySpacesAndPeriods(path, i + 11);
    const n = at(path, i + 7);
    if (iprefix(path, i, 'gitmod') && at(path, i + 6) === TILDE && n >= 0x31 && n <= 0x34)
        return onlySpacesAndPeriods(path, i + 8);
    const shortName = 'gi7eba';
    let k = 0;
    for (let tilde = false; k < 8; k++) {
        const c = at(path, i + k);
        if (c === 0)
            return false;
        if (tilde) {
            if (c < 0x30 || c > 0x39)
                return false;
        }
        else if (c === TILDE) {
            const digit = at(path, i + ++k);
            if (digit < 0x31 || digit > 0x39)
                return false;
            tilde = true;
        }
        else if (k >= 6 || c >= 0x80 || lower(c) !== shortName.charCodeAt(k)) {
            return false;
        }
    }
    return onlySpacesAndPeriods(path, i + k);
}
/** The code points HFS+ ignores in a name (next_hfs_char). */
const HFS_IGNORED = new Set([
    0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff,
]);
/** is_hfs_dot_generic: `.` and `word` at `i`, ignoring what HFS+ ignores, then the component's end. */
function isHfsDot(path, i, word) {
    const next = () => {
        for (;;) {
            if (i >= path.length)
                return 0;
            const c = path.codePointAt(i);
            i += c > 0xffff ? 2 : 1;
            if (!HFS_IGNORED.has(c))
                return c;
        }
    };
    if (next() !== DOT)
        return false;
    for (let k = 0; k < word.length; k++) {
        const c = next();
        if (c > 0x7f || lower(c) !== word.charCodeAt(k))
            return false;
    }
    const c = next();
    return c === 0 || c === SLASH;
}
/**
 * verify_path: whether git lets a repo-relative `path`, its entry's `mode`,
 * into its index: each component's start checked, then its characters
 * passed over to the next '/', a '\\' after its first character (protecting
 * NTFS) checked as a separator.
 */
export function verifyPath(path, mode, protect) {
    const link = (mode & 0o170000) === 0o120000;
    const length = path.length;
    for (let i = 0;;) {
        const first = i < length ? path.charCodeAt(i) : 0;
        if (first === 0 || first === SLASH || (first === DOT && !dotfileAllowed(path, i + 1, link)))
            return false;
        if (protect.hfs && (isHfsDot(path, i, 'git') || (link && isHfsDot(path, i, 'gitmodules'))))
            return false;
        // .git and git~1 start with '.', 'g' or 'G'.
        if (protect.ntfs && (((first === DOT || first === 0x67 || first === 0x47) && isNtfsDotgit(path, i)) || (link && isNtfsDotgitmodules(path, i))))
            return false;
        let j = i + 1;
        for (; j < length; j++) {
            const c = path.charCodeAt(j);
            if (c === SLASH)
                break;
            if (c === BACKSLASH && protect.ntfs && (isNtfsDotgit(path, j + 1) || (link && isNtfsDotgitmodules(path, j + 1))))
                return false;
        }
        if (j === length)
            return true;
        i = j + 1;
    }
}
