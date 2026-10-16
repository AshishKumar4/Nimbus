/**
 * git/worktree/pattern-lines.ts — a pattern file's lines (.gitignore,
 * info/exclude, info/sparse-checkout) as dir.c add_patterns_from_buffer
 * cuts them, before either grammar reads one.
 */

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

/**
 * The lines a pattern file gives: a UTF-8 BOM skipped; each line to its
 * LF, the last as if it ended in one (git appends it); an empty line or a
 * `#` comment skipped; then a CR before the LF dropped and trailing spaces
 * trimmed, so a line of a lone CR is an empty pattern, as git's is.
 */
export function patternLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (let i = start; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue;
    if (i !== start && bytes[start] !== 0x23) {
      const end = i > start && bytes[i - 1] === 0x0d ? i - 1 : i;
      lines.push(trimTrailingSpaces(bytes.subarray(start, end)));
    }
    start = i + 1;
  }
  return lines;
}
