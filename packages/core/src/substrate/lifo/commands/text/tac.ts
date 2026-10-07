import { getopt, type GetoptSpec } from '../../utils/args.js';
import type { Command } from '../types.js';
import { concatBytes, decodeLossless, encodeLossless, readAllInput, writeBytes } from '../../utils/bytes-io.js';
import { PosixRegexSyntax, translate } from '../../utils/posix-regex.js';
import { strerror } from '../../../../vfs/vfs-error.js';

// GNU tac (coreutils 9.7) on bytes: records in reverse order, each keeping
// its separator (after it, or before it with -b); -s STRING, -r (the
// separator is a basic regular expression). A last record without its
// separator is printed as it is, first.

const TAC_OPTIONS: GetoptSpec = {
  short: 'brs:',
  long: { before: ['b', 'none'], regex: ['r', 'none'], separator: ['s', 'required'] },
};

const command: Command = async (ctx) => {
  let before = false, regex = false;
  let separator = '\n';
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`tac: ${message}\nTry 'tac --help' for more information.\n`);
    return 1;
  };
  for (const event of getopt(ctx.args, TAC_OPTIONS)) {
    if (event.kind === 'error') return usage(event.message);
    if (event.kind === 'operand') files.push(event.value);
    else if (event.key === 'b') before = true;
    else if (event.key === 'r') regex = true;
    else separator = event.value!;
  }
  let pattern: RegExp | null = null;
  if (regex) {
    try {
      pattern = new RegExp(translate(separator, { extended: false }), 'gu');
    } catch (error) {
      if (!(error instanceof PosixRegexSyntax) && !(error instanceof SyntaxError)) throw error;
      await ctx.stderr.write(`tac: ${error instanceof PosixRegexSyntax ? error.message : 'Invalid regular expression'}\n`);
      return 1;
    }
  }
  // An empty separator is the NUL byte (tac.c counts its terminator).
  const sep = separator === '' ? Uint8Array.of(0) : encodeLossless(separator);

  let status = 0;
  for (const file of files.length > 0 ? files : ['-']) {
    let bytes: Uint8Array;
    try {
      bytes = await readAllInput(ctx, file);
    } catch (error) {
      await ctx.stderr.write(`tac: failed to open '${file}' for reading: ${strerror(error)}\n`);
      status = 1;
      continue;
    }
    // The separators' byte ranges.
    const matches: [number, number][] = [];
    if (pattern !== null) {
      const text = decodeLossless(bytes);
      // Map string offsets back to byte offsets.
      const byteAt = byteOffsets(text);
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
        if (m[0] === '') { pattern.lastIndex++; continue; }
        matches.push([byteAt[m.index], byteAt[m.index + m[0].length]]);
      }
    } else {
      for (let at = 0; at <= bytes.length - sep.length; ) {
        let hit = true;
        for (let k = 0; k < sep.length; k++) if (bytes[at + k] !== sep[k]) { hit = false; break; }
        if (hit) { matches.push([at, at + sep.length]); at += sep.length; } else at++;
      }
    }
    // Records: with the separator after (default) or before (-b).
    const records: Uint8Array[] = [];
    let start = 0;
    for (const [s, e] of matches) {
      if (before) {
        if (s > start || start === 0) records.push(bytes.subarray(start, s));
        start = s;
      } else {
        records.push(bytes.subarray(start, e));
        start = e;
      }
    }
    if (start < bytes.length) records.push(bytes.subarray(start));
    if (before && records.length > 0 && records[0].length === 0) records.shift();
    records.reverse();
    await writeBytes(ctx.stdout, concatBytes(records));
  }
  return status;
};

/** For each string offset of `text` (and its end), the byte offset in its lossless encoding. */
function byteOffsets(text: string): number[] {
  const out = new Array<number>(text.length + 1);
  let b = 0;
  for (let i = 0; i < text.length; i++) {
    out[i] = b;
    const c = text.charCodeAt(i);
    if (c >= 0xdc80 && c <= 0xdcff && !(i > 0 && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff)) b += 1;
    else if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { out[i + 1] = b; b += 4; i++; continue; }
    else b += 3;
  }
  out[text.length] = b;
  return out;
}

export default command;
