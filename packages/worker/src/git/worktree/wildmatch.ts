/**
 * git/worktree/wildmatch.ts — git's wildmatch.c, ported byte for byte.
 *
 * The matcher behind every .gitignore pattern (dir.c match_basename and
 * match_pathname call it through fnmatch_icase_mem). It works on bytes, as
 * git does, so a pattern and a path compare in their UTF-8 encodings; the end
 * of either array stands for C's terminating NUL.
 */

/** '/' is matched only by a literal '/' or by '**' (git's WM_PATHNAME). */
export const WM_PATHNAME = 2;

const WM_MATCH = 0;
const WM_NOMATCH = 1;
const WM_ABORT_ALL = -1;
const WM_ABORT_TO_STARSTAR = -2;

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN = 0x5b;
const CLOSE = 0x5d;
const COLON = 0x3a;
const DASH = 0x2d;
const BANG = 0x21;
const CARET = 0x5e;

// The C locale's ctype classes, ASCII only.
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const CLASSES: Record<string, (c: number) => boolean> = {
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: isAlpha,
  blank: (c) => c === 0x20 || c === 0x09,
  cntrl: (c) => c < 0x20 || c === 0x7f,
  digit: isDigit,
  graph: (c) => c > 0x20 && c <= 0x7e,
  lower: (c) => c >= 0x61 && c <= 0x7a,
  print: (c) => c >= 0x20 && c <= 0x7e,
  punct: (c) => c > 0x20 && c <= 0x7e && !isAlpha(c) && !isDigit(c),
  space: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  upper: (c) => c >= 0x41 && c <= 0x5a,
  xdigit: (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66),
};

/** dowild: `p` and `t` index `pat` and `text`; an index at the end reads as NUL. */
function dowild(pat: Uint8Array, p: number, text: Uint8Array, t: number, flags: number): number {
  const at = (bytes: Uint8Array, i: number) => (i < bytes.length ? bytes[i] : 0);
  const pattern = p;
  for (let pCh: number; (pCh = at(pat, p)) !== 0; t++, p++) {
    let matched: number;
    let matchSlash: boolean;
    let tCh = at(text, t);
    if (tCh === 0 && pCh !== STAR) return WM_ABORT_ALL;
    switch (pCh) {
      case BACKSLASH:
        // A literal match with the next character; the end of the pattern fails it below.
        pCh = at(pat, ++p);
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
      case QUESTION:
        if ((flags & WM_PATHNAME) && tCh === SLASH) return WM_NOMATCH;
        continue;
      case STAR: {
        if (at(pat, ++p) === STAR) {
          const prevP = p;
          while (at(pat, ++p) === STAR) { /* skip the run */ }
          if (!(flags & WM_PATHNAME)) {
            matchSlash = true;
          } else if ((prevP - pattern < 2 || at(pat, prevP - 2) === SLASH)
            && (at(pat, p) === 0 || at(pat, p) === SLASH || (at(pat, p) === BACKSLASH && at(pat, p + 1) === SLASH))) {
            // foo/**/bar matches foo/bar too: try '**/' as matching nothing first.
            if (at(pat, p) === SLASH && dowild(pat, p + 1, text, t, flags) === WM_MATCH) return WM_MATCH;
            matchSlash = true;
          } else {
            matchSlash = false;
          }
        } else {
          matchSlash = !(flags & WM_PATHNAME);
        }
        if (at(pat, p) === 0) {
          // A trailing '**' matches everything, a trailing '*' only what has no more slashes.
          if (!matchSlash && text.indexOf(SLASH, t) >= 0) return WM_ABORT_TO_STARSTAR;
          return WM_MATCH;
        }
        if (!matchSlash && at(pat, p) === SLASH) {
          // One '*' then '/' under WM_PATHNAME matches the rest of this directory name.
          const slash = text.indexOf(SLASH, t);
          if (slash < 0) return WM_ABORT_ALL;
          t = slash;
          // The slash is consumed by the loop.
          break;
        }
        for (;;) {
          if (tCh === 0) break;
          // A literal after the '*': skip ahead to where it next occurs.
          pCh = at(pat, p);
          if (pCh !== STAR && pCh !== QUESTION && pCh !== OPEN && pCh !== BACKSLASH) {
            while ((tCh = at(text, t)) !== 0 && (matchSlash || tCh !== SLASH)) {
              if (tCh === pCh) break;
              t++;
            }
            if (tCh !== pCh) return matchSlash ? WM_ABORT_ALL : WM_ABORT_TO_STARSTAR;
          }
          if ((matched = dowild(pat, p, text, t, flags)) !== WM_NOMATCH) {
            if (!matchSlash || matched !== WM_ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tCh === SLASH) {
            return WM_ABORT_TO_STARSTAR;
          }
          tCh = at(text, ++t);
        }
        return WM_ABORT_ALL;
      }
      case OPEN: {
        pCh = at(pat, ++p);
        if (pCh === CARET) pCh = BANG;
        const negated = pCh === BANG ? 1 : 0;
        if (negated) pCh = at(pat, ++p);
        let prevCh = 0;
        matched = 0;
        do {
          if (!pCh) return WM_ABORT_ALL;
          if (pCh === BACKSLASH) {
            pCh = at(pat, ++p);
            if (!pCh) return WM_ABORT_ALL;
            if (tCh === pCh) matched = 1;
          } else if (pCh === DASH && prevCh && at(pat, p + 1) && at(pat, p + 1) !== CLOSE) {
            pCh = at(pat, ++p);
            if (pCh === BACKSLASH) {
              pCh = at(pat, ++p);
              if (!pCh) return WM_ABORT_ALL;
            }
            if (tCh <= pCh && tCh >= prevCh) matched = 1;
            pCh = 0; // prev_ch becomes 0: a range ends a range
          } else if (pCh === OPEN && at(pat, p + 1) === COLON) {
            p += 2;
            const s = p;
            while ((pCh = at(pat, p)) && pCh !== CLOSE) p++;
            if (!pCh) return WM_ABORT_ALL;
            const length = p - s - 1;
            if (length < 0 || at(pat, p - 1) !== COLON) {
              // No ":]": the '[' is an ordinary member of the set.
              p = s - 2;
              pCh = OPEN;
              if (tCh === pCh) matched = 1;
            } else {
              const test = CLASSES[String.fromCharCode(...pat.subarray(s, s + length))];
              if (!test) return WM_ABORT_ALL;
              if (test(tCh)) matched = 1;
              pCh = 0;
            }
          } else if (tCh === pCh) {
            matched = 1;
          }
          prevCh = pCh;
          pCh = at(pat, ++p);
        } while (pCh !== CLOSE);
        if (matched === negated || ((flags & WM_PATHNAME) && tCh === SLASH)) return WM_NOMATCH;
        continue;
      }
      default:
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
    }
  }
  return t < text.length ? WM_NOMATCH : WM_MATCH;
}

/** wildmatch(): whether `pattern` matches all of `text`. */
export function wildmatch(pattern: Uint8Array, text: Uint8Array, flags = 0): boolean {
  return dowild(pattern, 0, text, 0, flags) === WM_MATCH;
}
