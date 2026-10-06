import type { Command } from '../types.js';
import { asciiBytes, concatBytes, decodeLossless, encodeLossless, inputChunks, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { translate } from '../../utils/posix-regex.js';

// GNU nl (coreutils 9.7) on bytes. Logical pages of header, body and footer
// sections, delimited by lines that are exactly `\:\:\:`, `\:\:` and `\:`
// (-d changes the two characters); each section numbers by its style (-h,
// -b, -f: a all, t non-empty, n none, pBRE matching). A delimiter line prints
// as an empty line; an unnumbered line is indented by the width plus the
// separator. Numbering restarts at each page unless -p.

type Style = { kind: 'a' | 't' | 'n' } | { kind: 'p'; re: RegExp };

class NlUsage extends Error {}

function style(value: string, which: string): Style {
  if (value === 'a' || value === 't' || value === 'n') return { kind: value };
  if (value.startsWith('p')) {
    try {
      return { kind: 'p', re: new RegExp(translate(value.slice(1), { extended: false }), 'u') };
    } catch {
      throw new NlUsage(`invalid ${which} numbering style: \u2018${value}\u2019`);
    }
  }
  throw new NlUsage(`invalid ${which} numbering style: \u2018${value}\u2019`);
}

const command: Command = async (ctx) => {
  const styles: Record<'h' | 'b' | 'f', Style> = { h: { kind: 'n' }, b: { kind: 't' }, f: { kind: 'n' } };
  let format: 'ln' | 'rn' | 'rz' = 'rn';
  let width = 6;
  let separator = '\t';
  let start = 1;
  let increment = 1;
  let join = 1;
  let renumber = true;
  let delim = '\\:';
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`nl: ${message}\nTry 'nl --help' for more information.\n`);
    return 1;
  };
  const int = (value: string, what: string): number => {
    if (!/^-?\d+$/.test(value)) throw new NlUsage(`invalid ${what}: \u2018${value}\u2019`);
    return Number(value);
  };
  try {
    const args = ctx.args;
    const long: Record<string, string> = {
      'header-numbering': 'h', 'body-numbering': 'b', 'footer-numbering': 'f', 'number-format': 'n',
      'number-width': 'w', 'number-separator': 's', 'starting-line-number': 'v', 'line-increment': 'i',
      'join-blank-lines': 'l', 'section-delimiter': 'd', 'no-renumber': 'p',
    };
    const apply = (flag: string, value: string | undefined): void => {
      switch (flag) {
        case 'h': case 'b': case 'f':
          styles[flag] = style(value!, flag === 'h' ? 'header' : flag === 'b' ? 'body' : 'footer');
          break;
        case 'n':
          if (value !== 'ln' && value !== 'rn' && value !== 'rz') throw new NlUsage(`invalid line numbering format: \u2018${value}\u2019`);
          format = value;
          break;
        case 'w':
          width = int(value!, 'line number field width');
          if (width < 1) throw new NlUsage(`invalid line number field width: \u2018${value}\u2019`);
          break;
        case 's': separator = value!; break;
        case 'v': start = int(value!, 'starting line number'); break;
        case 'i': increment = int(value!, 'line number increment'); break;
        case 'l':
          join = int(value!, 'line number of blank lines');
          if (join < 1) throw new NlUsage(`invalid line number of blank lines: \u2018${value}\u2019`);
          break;
        case 'd': delim = value!.length === 1 ? `${value}:` : value!; break;
        case 'p': renumber = false; break;
        default: throw new NlUsage(`invalid option -- '${flag}'`);
      }
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') { files.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
        const flag = long[name];
        if (flag === undefined) throw new NlUsage(`unrecognized option '--${name}'`);
        apply(flag, flag === 'p' ? undefined : inline ?? args[++i]);
        continue;
      }
      if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === 'p') { apply('p', undefined); continue; }
        let value: string | undefined = arg.slice(j + 1);
        if (value === '') value = args[++i];
        if (value === undefined) throw new NlUsage(`option requires an argument -- '${flag}'`);
        apply(flag, value);
        break;
      }
    }
  } catch (error) {
    if (error instanceof NlUsage) return usage(error.message);
    throw error;
  }

  const header = encodeLossless(delim.repeat(3));
  const body = encodeLossless(delim.repeat(2));
  const footer = encodeLossless(delim);
  const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const blank = asciiBytes(' '.repeat(width) + ' '.repeat(encodeLossless(separator).length));
  const sep = encodeLossless(separator);
  const nl = Uint8Array.of(0x0a);
  const numberText = (n: number): string => {
    const digits = String(Math.abs(n));
    const signed = n < 0 ? `-${digits}` : digits;
    if (format === 'ln') return signed.padEnd(width);
    if (format === 'rz') return n < 0 ? `-${digits.padStart(width - 1, '0')}` : digits.padStart(width, '0');
    return signed.padStart(width);
  };

  let line = start;
  let section: 'h' | 'b' | 'f' = 'b';
  let blanks = 0;
  let status = 0;
  for (const file of files.length > 0 ? files : ['-']) {
    let bytes: Uint8Array;
    try {
      const parts: Uint8Array[] = [];
      for await (const chunk of inputChunks(ctx, file)) parts.push(chunk);
      bytes = concatBytes(parts);
    } catch (error) {
      await ctx.stderr.write(`nl: ${file}: ${strerror(error)}\n`);
      status = 1;
      continue;
    }
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < bytes.length) {
      const end = bytes.indexOf(0x0a, at);
      const record = bytes.subarray(at, end === -1 ? bytes.length : end);
      at = end === -1 ? bytes.length : end + 1;
      const next: 'h' | 'b' | 'f' | null = equal(record, header) ? 'h' : equal(record, body) ? 'b' : equal(record, footer) ? 'f' : null;
      if (next !== null) {
        // Each section starts its numbering over, unless -p.
        if (renumber) line = start;
        section = next;
        out.push(nl);
        continue;
      }
      const s = styles[section];
      let numbered: boolean;
      if (s.kind === 'a') {
        if (record.length === 0) {
          blanks++;
          numbered = blanks >= join;
          if (numbered) blanks = 0;
        } else {
          blanks = 0;
          numbered = true;
        }
      } else if (s.kind === 't') numbered = record.length > 0;
      else if (s.kind === 'n') numbered = false;
      else if (s.kind === 'p') numbered = s.re.test(decodeLossless(record));
      else numbered = false;
      if (numbered) {
        out.push(asciiBytes(numberText(line)), sep);
        line += increment;
      } else {
        out.push(blank);
      }
      out.push(record, nl);
    }
    await writeBytes(ctx.stdout, concatBytes(out));
  }
  return status;
};

export default command;
