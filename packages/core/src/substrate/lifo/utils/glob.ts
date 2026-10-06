import type { ProcessView } from '../../../runtime/process-files.js';
import { resolve } from './path.js';
import { exists } from '../../../vfs/vfs.js';

/**
 * Match a glob pattern against a text string, as fnmatch(3) without flags:
 * `*`, `?`, `[abc]`, `[!a-z]` (`^` too; `]` first is literal), `\` quotes the
 * next character (a trailing one matches nothing), and a `[` with no closing
 * `]` is a literal `[`.
 */
export function globMatch(pattern: string, text: string): boolean {
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
    const next = pi < pattern.length ? matchOne(pattern, pi, text[ti]!) : -1;
    if (next >= 0) {
      pi = next;
      ti++;
      continue;
    }
    if (starPi < 0) return false;
    pi = starPi + 1;
    ti = ++starTi;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

/** Where the pattern continues after its token at `pi` matched `ch`, or -1. */
function matchOne(pattern: string, pi: number, ch: string): number {
  const c = pattern[pi]!;
  if (c === '?') return pi + 1;
  if (c === '\\') {
    // A trailing backslash quotes nothing and matches nothing (glibc).
    return pi + 1 < pattern.length && pattern[pi + 1] === ch ? pi + 2 : -1;
  }
  if (c === '[') {
    const cls = matchCharClass(pattern, pi, ch);
    if (cls !== null) return cls.matched ? cls.end : -1;
  }
  return c === ch ? pi + 1 : -1;
}

/** A bracket expression at `pos`: whether it matches `ch` and where it ends; null when it never closes. */
function matchCharClass(pattern: string, pos: number, ch: string): { matched: boolean; end: number } | null {
  let i = pos + 1;
  let negate = false;
  if (i < pattern.length && (pattern[i] === '!' || pattern[i] === '^')) {
    negate = true;
    i++;
  }
  let matched = false;
  const start = i;
  while (i < pattern.length && (pattern[i] !== ']' || i === start)) {
    let lo = pattern[i]!;
    if (lo === '\\' && i + 1 < pattern.length) lo = pattern[++i]!;
    if (i + 2 < pattern.length && pattern[i + 1] === '-' && pattern[i + 2] !== ']') {
      let hi = pattern[i + 2]!;
      let end = i + 3;
      if (hi === '\\' && i + 3 < pattern.length) { hi = pattern[i + 3]!; end = i + 4; }
      if (ch >= lo && ch <= hi) matched = true;
      i = end;
    } else {
      if (ch === lo) matched = true;
      i++;
    }
  }
  if (i >= pattern.length) return null;
  return { matched: negate ? !matched : matched, end: i + 1 };
}

/**
 * Expand a glob pattern against the VFS.
 * Returns sorted matching paths, or [pattern] if no matches.
 */
export async function expandGlob(pattern: string, cwd: string, vfs: ProcessView): Promise<string[]> {
  // If no glob chars, return as-is
  if (!hasGlobChars(pattern)) {
    return [pattern];
  }

  const absPattern = pattern.startsWith('/') ? pattern : resolve(cwd, pattern);
  const parts = absPattern.split('/').filter(Boolean);
  const isAbsolute = pattern.startsWith('/');

  let candidates = ['/'];

  for (const part of parts) {
    const nextCandidates: string[] = [];

    if (!hasGlobChars(part)) {
      // Literal path segment
      for (const dir of candidates) {
        const full = dir === '/' ? `/${part}` : `${dir}/${part}`;
        if (await vfs.exists(full)) {
          nextCandidates.push(full);
        }
      }
    } else {
      // Glob segment -- match against directory entries
      for (const dir of candidates) {
        try {
          const entries = await vfs.readdir(dir);
          for (const entry of entries) {
            if (globMatch(part, entry.name)) {
              const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
              nextCandidates.push(full);
            }
          }
        } catch {
          // dir doesn't exist or isn't a directory
        }
      }
    }

    candidates = nextCandidates;
  }

  if (candidates.length === 0) {
    return [pattern]; // no matches, return literal
  }

  // Convert back to relative paths if pattern was relative
  let results: string[];
  if (isAbsolute) {
    results = candidates;
  } else {
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

/** Whether `s` holds a glob's special characters (`*`, `?`, `[`). */
export function hasGlobChars(s: string): boolean {
  return s.includes('*') || s.includes('?') || s.includes('[');
}
