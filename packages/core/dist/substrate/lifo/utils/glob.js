import { resolve } from './path.js';
/**
 * Match a glob pattern against a text string, as fnmatch(3) without flags:
 * `*`, `?`, `[abc]`, `[!a-z]` (`^` too; `]` first is literal), `\` quotes the
 * next character (a trailing one matches nothing), and a `[` with no closing
 * `]` is a literal `[`.
 */
export function globMatch(pattern, text) {
    return matchPattern(pattern, text, false);
}
/**
 * Match as bash's strmatch does (the shell's case, [[ ]], pathname expansion
 * and pattern operators): as globMatch, but a final backslash matches a
 * backslash (bash's sm_loop), where fnmatch(3)'s matches nothing.
 */
export function shellMatch(pattern, text) {
    return matchPattern(pattern, text, true);
}
function matchPattern(pattern, text, finalBackslash) {
    let pi = 0;
    let ti = 0;
    let starPi = -1;
    let starTi = -1;
    while (ti < text.length) {
        if (pi < pattern.length && pattern[pi] === '*') {
            starPi = pi++;
            starTi = ti;
            continue;
        }
        const next = pi < pattern.length ? matchOne(pattern, pi, text[ti], finalBackslash) : -1;
        if (next >= 0) {
            pi = next;
            ti++;
            continue;
        }
        if (starPi < 0)
            return false;
        pi = starPi + 1;
        ti = ++starTi;
    }
    while (pi < pattern.length && pattern[pi] === '*')
        pi++;
    return pi === pattern.length;
}
/** Where the pattern continues after its token at `pi` matched `ch`, or -1. */
function matchOne(pattern, pi, ch, finalBackslash) {
    const c = pattern[pi];
    if (c === '?')
        return pi + 1;
    if (c === '\\') {
        // A trailing backslash quotes nothing: it matches nothing (glibc), or itself (bash).
        if (pi + 1 >= pattern.length)
            return finalBackslash && ch === '\\' ? pi + 1 : -1;
        return pattern[pi + 1] === ch ? pi + 2 : -1;
    }
    if (c === '[') {
        const cls = matchCharClass(pattern, pi, ch);
        if (cls !== null)
            return cls.matched ? cls.end : -1;
    }
    return c === ch ? pi + 1 : -1;
}
/** A bracket expression at `pos`: whether it matches `ch` and where it ends; null when it never closes. */
function matchCharClass(pattern, pos, ch) {
    let i = pos + 1;
    let negate = false;
    if (i < pattern.length && (pattern[i] === '!' || pattern[i] === '^')) {
        negate = true;
        i++;
    }
    let matched = false;
    const start = i;
    while (i < pattern.length && (pattern[i] !== ']' || i === start)) {
        let lo = pattern[i];
        if (lo === '\\' && i + 1 < pattern.length)
            lo = pattern[++i];
        if (i + 2 < pattern.length && pattern[i + 1] === '-' && pattern[i + 2] !== ']') {
            let hi = pattern[i + 2];
            let end = i + 3;
            if (hi === '\\' && i + 3 < pattern.length) {
                hi = pattern[i + 3];
                end = i + 4;
            }
            if (ch >= lo && ch <= hi)
                matched = true;
            i = end;
        }
        else {
            if (ch === lo)
                matched = true;
            i++;
        }
    }
    if (i >= pattern.length)
        return null;
    return { matched: negate ? !matched : matched, end: i + 1 };
}
/**
 * Expand a field against the VFS: `pattern` is the field as globMatch reads it
 * (its quoted characters escaped), `text` the field itself. Returns the sorted
 * matching paths, or [text] when the pattern has no unescaped glob character
 * or nothing matches.
 */
export async function expandGlob(pattern, text, cwd, vfs) {
    if (!hasUnescapedGlob(pattern)) {
        return [text];
    }
    // The working directory's name matches only itself: escaped, as the pattern's quoted characters are.
    const absPattern = pattern.startsWith('/') ? pattern : resolve(escapeGlob(cwd), pattern);
    const parts = absPattern.split('/').filter(Boolean);
    const isAbsolute = pattern.startsWith('/');
    let candidates = ['/'];
    for (const part of parts) {
        const nextCandidates = [];
        if (!hasUnescapedGlob(part)) {
            // Literal path segment
            const name = unescapeGlob(part);
            for (const dir of candidates) {
                const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
                if (await vfs.exists(full)) {
                    nextCandidates.push(full);
                }
            }
        }
        else {
            // Glob segment -- match against directory entries
            for (const dir of candidates) {
                try {
                    const entries = await vfs.readdir(dir);
                    for (const entry of entries) {
                        if (shellMatch(part, entry.name)) {
                            const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
                            nextCandidates.push(full);
                        }
                    }
                }
                catch {
                    // dir doesn't exist or isn't a directory
                }
            }
        }
        candidates = nextCandidates;
    }
    if (candidates.length === 0) {
        return [text]; // no matches: the field as it is
    }
    // Convert back to relative paths if pattern was relative
    let results;
    if (isAbsolute) {
        results = candidates;
    }
    else {
        const prefix = cwd === '/' ? '/' : cwd + '/';
        results = candidates.map((c) => {
            if (c.startsWith(prefix)) {
                return c.slice(prefix.length);
            }
            return c;
        });
    }
    return results.sort();
}
/**
 * How many characters `pattern` matches when that is fixed (no `*` in it), as
 * bash's umatchlen: each `?`, character, backslash-quoted character or bracket
 * expression is one. Null when it varies.
 */
export function fixedMatchLength(pattern) {
    let length = 0;
    for (let i = 0; i < pattern.length; length++) {
        const c = pattern[i];
        if (c === '*')
            return null;
        if (c === '\\')
            i += 2;
        else if (c === '[')
            i = classEnd(pattern, i) ?? i + 1;
        else
            i++;
    }
    return length;
}
/** Where the bracket expression at `pos` ends, just past its `]`, or null when it never closes (as matchCharClass reads it). */
function classEnd(pattern, pos) {
    let i = pos + 1;
    if (pattern[i] === '!' || pattern[i] === '^')
        i++;
    const start = i;
    while (i < pattern.length && (pattern[i] !== ']' || i === start))
        i += pattern[i] === '\\' ? 2 : 1;
    return i < pattern.length ? i + 1 : null;
}
/** Whether `s` holds a glob's special characters (`*`, `?`, `[`). */
export function hasGlobChars(s) {
    return s.includes('*') || s.includes('?') || s.includes('[');
}
/**
 * `text` as a pattern that matches only itself: each character globMatch reads
 * specially quoted with a backslash, a bracket expression's `-`, `!` and `^`
 * too (`[a$'-'z]` holds a, - and z).
 */
export function escapeGlob(text) {
    return text.replace(/[\\*?[\]\-!^]/g, '\\$&');
}
/** Whether pattern `s` holds a glob character no backslash quotes. */
function hasUnescapedGlob(s) {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\')
            i++;
        else if (s[i] === '*' || s[i] === '?' || s[i] === '[')
            return true;
    }
    return false;
}
/** Pattern `s` with its backslash quoting removed: the name it matches when it has no glob character. */
function unescapeGlob(s) {
    return s.replace(/\\(.)/gs, '$1');
}
