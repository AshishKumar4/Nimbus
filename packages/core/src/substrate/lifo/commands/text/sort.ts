import { getopt, type GetoptSpec } from '../../utils/args.js';
import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { asciiUpper, concatBytes, decodeLossless, encodeLossless, isBlank, readAllInput, skipBlankField, splitRecords, writeBytes } from '../../utils/bytes-io.js';
import { createHash } from 'node:crypto';
import { strerror } from '../../../../vfs/vfs-error.js';

// GNU sort (coreutils 9.7) in en_US.UTF-8, on bytes. Keys (-k, -t), the
// orderings -n -g -h -M -V -R (with --random-source), modifiers -b -d -f -i
// -r, -u, -s, -c/-C, -m, -o, -z. Text compares as glibc's collation does: punctuation, symbols and
// spaces (not currency) are ignored until everything else is equal, lower
// case before upper, then those ignored characters decide, then the bytes.
// Known limit: among strings that differ only in punctuation, glibc's
// fourth level can order a pair differently.

const collator = new Intl.Collator('en-US', { caseFirst: 'lower' });
// A byte that is not valid UTF-8 (held as U+DC80 + byte, bytes-io.ts) is ignorable too.
const IGNORABLE = /[\p{P}\p{Sm}\p{Sk}\p{So}\p{Z}\s\udc80-\udcff]/u;
/** glibc's order among the ASCII characters it ignores. */
const IGNORABLE_ORDER = '\t !"#%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

interface CollationKey { text: string; chars: string[]; primary: string }

function collationKey(text: string): CollationKey {
  const chars = [...text];
  return { text, chars, primary: chars.filter((c) => !IGNORABLE.test(c)).join('') };
}

function ignorableWeight(ch: string): number {
  const i = IGNORABLE_ORDER.indexOf(ch);
  return i === -1 ? IGNORABLE_ORDER.length : i;
}

function collate(a: CollationKey, b: CollationKey): number {
  if (a.text === b.text) return 0;
  const p = collator.compare(a.primary, b.primary);
  if (p !== 0) return p;
  const n = Math.min(a.chars.length, b.chars.length);
  for (let i = 0; i < n; i++) {
    const x = a.chars[i], y = b.chars[i];
    if (x === y) continue;
    const ix = IGNORABLE.test(x), iy = IGNORABLE.test(y);
    if (ix && !iy) return -1;
    if (!ix && iy) return 1;
    if (ix && iy) return ignorableWeight(x) - ignorableWeight(y) || (x < y ? -1 : 1);
    return collator.compare(x, y) || (x < y ? -1 : 1);
  }
  return a.chars.length - b.chars.length;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// ── orderings ──


/** -n: optional blanks, sign, digits with ',' thousands groups, '.' fraction. */
function numericValue(s: string): { neg: boolean; int: string; frac: string } | null {
  const m = /^[ \t]*(-?)((?:\d+(?:,\d+)*)?)(?:\.(\d*))?/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
  const int = m[2].replace(/,/g, '').replace(/^0+/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  return { neg: m[1] === '-' && (int !== '' || frac !== ''), int, frac };
}

function compareNumeric(a: string, b: string): number {
  const x = numericValue(a) ?? { neg: false, int: '', frac: '' };
  const y = numericValue(b) ?? { neg: false, int: '', frac: '' };
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const sign = x.neg ? -1 : 1;
  if (x.int.length !== y.int.length) return sign * (x.int.length - y.int.length);
  if (x.int !== y.int) return sign * (x.int < y.int ? -1 : 1);
  if (x.frac !== y.frac) return sign * (x.frac < y.frac ? -1 : 1);
  return 0;
}

function generalValue(s: string): number {
  const m = /^[ \t]*([-+]?(?:0x[0-9a-f]+(?:\.[0-9a-f]*)?(?:p[-+]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|inf(?:inity)?|nan))/i.exec(s);
  if (!m) return NaN;
  const t = m[1].toLowerCase();
  if (/inf/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/nan/.test(t)) return NaN;
  const hex = /^([-+]?)0x([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([-+]?\d+))?$/.exec(t);
  if (hex) {
    const frac = hex[3] ?? '';
    const mantissa = parseInt(hex[2] || '0', 16) + (frac === '' ? 0 : parseInt(frac, 16) / 16 ** frac.length);
    return (hex[1] === '-' ? -1 : 1) * mantissa * 2 ** Number(hex[4] ?? 0);
  }
  return Number(t);
}

function compareGeneral(a: string, b: string): number {
  const x = generalValue(a), y = generalValue(b);
  const xn = Number.isNaN(x), yn = Number.isNaN(y);
  if (xn || yn) return xn && yn ? 0 : xn ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

const SI = ' KMGTPEZYRQ';
function compareHuman(a: string, b: string): number {
  const unit = (s: string) => {
    const m = /^[ \t]*(-?)(?:\d+(?:,\d+)*)?(?:\.\d*)?([KMGTPEZYRQk]?)/.exec(s);
    if (!m) return 0;
    const u = m[2] === 'k' ? 1 : Math.max(0, SI.indexOf(m[2]));
    return (m[1] === '-' ? -1 : 1) * u;
  };
  const ua = unit(a), ub = unit(b);
  if (ua !== ub) return ua - ub;
  return compareNumeric(a, b);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function monthOf(s: string): number {
  const t = s.replace(/^[ \t]+/, '').slice(0, 3).toUpperCase();
  return MONTHS.indexOf(t) + 1;
}

/** gnulib's filevercmp, on the key's characters. */
function versionCompare(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  if (a === '.') return -1;
  if (b === '.') return 1;
  if (a === '..') return -1;
  if (b === '..') return 1;
  if (a.startsWith('.') && !b.startsWith('.')) return -1;
  if (!a.startsWith('.') && b.startsWith('.')) return 1;
  if (a.startsWith('.') && b.startsWith('.')) { a = a.slice(1); b = b.slice(1); }
  const suffix = (s: string) => {
    const m = /(?:\.[A-Za-z~][A-Za-z0-9~]*)*$/.exec(s);
    return m ? s.length - m[0].length : s.length;
  };
  const al = suffix(a), bl = suffix(b);
  const r = verrevcmp(a.slice(0, al), b.slice(0, bl));
  return r !== 0 ? r : verrevcmp(a, b);
}

function verOrder(c: string | undefined): number {
  if (c === undefined) return 0;
  if (/[0-9]/.test(c)) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  if (c === '~') return -1;
  return c.charCodeAt(0) + 256;
}

function verrevcmp(s1: string, s2: string): number {
  let i = 0, j = 0;
  while (i < s1.length || j < s2.length) {
    let firstDiff = 0;
    while ((i < s1.length && !/[0-9]/.test(s1[i])) || (j < s2.length && !/[0-9]/.test(s2[j]))) {
      const x = verOrder(i < s1.length ? s1[i] : undefined);
      const y = verOrder(j < s2.length ? s2[j] : undefined);
      if (x !== y) return x - y;
      i++; j++;
    }
    while (s1[i] === '0') i++;
    while (s2[j] === '0') j++;
    while (i < s1.length && j < s2.length && /[0-9]/.test(s1[i]) && /[0-9]/.test(s2[j])) {
      if (!firstDiff) firstDiff = s1.charCodeAt(i) - s2.charCodeAt(j);
      i++; j++;
    }
    if (i < s1.length && /[0-9]/.test(s1[i])) return 1;
    if (j < s2.length && /[0-9]/.test(s2[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

// ── keys ──

interface Ordering {
  blanksStart: boolean; blanksEnd: boolean; dictionary: boolean; fold: boolean; nonprinting: boolean;
  kind: 'text' | 'n' | 'g' | 'h' | 'M' | 'V' | 'R'; reverse: boolean;
}
interface Key extends Ordering { startField: number; startChar: number; endField: number; endChar: number }

/** A usage error: its message, and the status (2, or 1 for an argument argmatch refuses, as GNU's). */
class SortUsage extends Error {
  constructor(message: string, readonly status = 2) { super(message); }
}

/** --sort's words, as GNU lists them, and the ordering letter each is. */
const SORT_ORDERS: Record<string, string> = {
  'general-numeric': 'g', 'human-numeric': 'h', month: 'M', numeric: 'n', random: 'R', version: 'V',
};
const SORT_NAMES = Object.keys(SORT_ORDERS);

const ORDER_LETTERS = 'bdfgiMhnRrV';

function applyOrderLetter(o: Ordering, c: string, end: boolean): void {
  switch (c) {
    case 'b': if (end) o.blanksEnd = true; else o.blanksStart = true; break;
    case 'd': o.dictionary = true; break;
    case 'f': o.fold = true; break;
    case 'i': o.nonprinting = true; break;
    case 'r': o.reverse = true; break;
    case 'g': case 'h': case 'M': case 'n': case 'R': case 'V':
      if (o.kind !== 'text' && o.kind !== c) throw new SortUsage(`options '-${o.kind}${c}' are incompatible`);
      o.kind = c;
      break;
  }
}

function parseKey(spec: string, global: Ordering): Key {
  const m = /^(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*))?$/.exec(spec);
  if (!m) throw new SortUsage(`invalid number at field start: invalid count at start of \u2018${spec}\u2019`);
  const startField = Number(m[1]);
  const startChar = m[2] === undefined ? 1 : Number(m[2]);
  if (startField === 0) throw new SortUsage(`field number is zero: invalid field specification \u2018${spec}\u2019`);
  if (startChar === 0) throw new SortUsage(`character offset is zero: invalid field specification \u2018${spec}\u2019`);
  const key: Key = {
    blanksStart: false, blanksEnd: false, dictionary: false, fold: false, nonprinting: false, kind: 'text', reverse: false,
    startField, startChar, endField: m[4] === undefined ? Infinity : Number(m[4]), endChar: m[5] === undefined ? 0 : Number(m[5]),
  };
  if (m[4] !== undefined && key.endField === 0) throw new SortUsage(`field number is zero: invalid field specification \u2018${spec}\u2019`);
  const letters = (m[3] ?? '') + (m[6] ?? '');
  if (letters === '') {
    // A key without its own ordering options takes the global ones.
    Object.assign(key, { ...global, startField: key.startField, startChar: key.startChar, endField: key.endField, endChar: key.endChar });
  } else {
    for (const c of m[3] ?? '') applyOrderLetter(key, c, false);
    for (const c of m[6] ?? '') applyOrderLetter(key, c, true);
  }
  return key;
}

/** The byte range of `key` in `line`. */
function keyRange(line: Uint8Array, key: Key, tab: number | null): [number, number] {
  const fieldStart = (field: number): number => {
    let at = 0;
    for (let f = 1; f < field; f++) {
      if (tab !== null) {
        const i = line.indexOf(tab, at);
        if (i === -1) return line.length;
        at = i + 1;
      } else {
        at = skipBlankField(line, at);
      }
    }
    return at;
  };
  let start = fieldStart(key.startField);
  if (key.blanksStart) while (start < line.length && isBlank(line[start])) start++;
  start = Math.min(line.length, start + key.startChar - 1);
  let end: number;
  if (key.endField === Infinity) end = line.length;
  else if (key.endChar === 0) {
    // To the end of the field.
    let at = fieldStart(key.endField);
    if (tab !== null) {
      const i = line.indexOf(tab, at);
      end = i === -1 ? line.length : i;
    } else {
      end = skipBlankField(line, at);
    }
  } else {
    let at = fieldStart(key.endField);
    if (key.blanksEnd) while (at < line.length && isBlank(line[at])) at++;
    end = Math.min(line.length, at + key.endChar);
  }
  return [start, Math.max(start, end)];
}

function transformText(bytes: Uint8Array, o: Ordering): Uint8Array {
  if (!o.dictionary && !o.fold && !o.nonprinting) return bytes;
  const out: number[] = [];
  for (const b of bytes) {
    // Byte classes, as GNU's tables are: a non-ASCII byte is neither alnum nor printable.
    if (o.dictionary && !(isBlank(b) || (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122))) continue;
    if (o.nonprinting && b >= 0x80) continue;
    if (o.nonprinting && (b < 32 || b === 127)) continue;
    out.push(o.fold ? asciiUpper(b) : b);
  }
  return Uint8Array.from(out);
}

/**
 * -R: keys ordered by the MD5 of a 16-byte salt followed by the key, as GNU
 * sort's compare_random does, so equal keys sort together and a
 * --random-source fixes the order. The salt is the source's first 16 bytes,
 * or random ones. GNU hashes the key's strxfrm transform in a locale that
 * collates (en_US.UTF-8), and its bytes in the C locale; this hashes the
 * bytes, so a --random-source orders keys as GNU's C-locale sort does.
 */
class RandomOrder {
  private readonly digests = new Map<string, Uint8Array>();
  constructor(private readonly salt: Uint8Array) {}

  compare(a: Uint8Array, b: Uint8Array): number {
    return compareBytes(this.digest(a), this.digest(b)) || compareBytes(a, b);
  }

  private digest(key: Uint8Array): Uint8Array {
    const id = decodeLossless(key);
    const cached = this.digests.get(id);
    if (cached) return cached;
    const digest = new Uint8Array(createHash('md5').update(this.salt).update(key).digest());
    this.digests.set(id, digest);
    return digest;
  }
}

function compareKey(a: Uint8Array, b: Uint8Array, o: Ordering, random: RandomOrder | null): number {
  let d: number;
  if (o.kind === 'R') {
    d = random!.compare(transformText(a, o), transformText(b, o));
  } else if (o.kind === 'text') {
    const x = transformText(a, o), y = transformText(b, o);
    d = collate(collationKey(decodeLossless(x)), collationKey(decodeLossless(y)));
  } else {
    const x = decodeLossless(a), y = decodeLossless(b);
    if (o.kind === 'n') d = compareNumeric(x, y);
    else if (o.kind === 'g') d = compareGeneral(x, y);
    else if (o.kind === 'h') d = compareHuman(x, y);
    else if (o.kind === 'M') d = monthOf(x) - monthOf(y);
    else d = versionCompare(x, y);
  }
  return o.reverse ? -d : d;
}

const SORT_OPTIONS: GetoptSpec = {
  short: 'bcCdfghik:mMno:rRsS:t:T:uVz',
  long: {
    'ignore-leading-blanks': ['b', 'none'], 'dictionary-order': ['d', 'none'], 'ignore-case': ['f', 'none'],
    'general-numeric-sort': ['g', 'none'], 'ignore-nonprinting': ['i', 'none'], 'month-sort': ['M', 'none'],
    'human-numeric-sort': ['h', 'none'], 'numeric-sort': ['n', 'none'], 'random-sort': ['R', 'none'],
    reverse: ['r', 'none'], 'version-sort': ['V', 'none'], merge: ['m', 'none'], stable: ['s', 'none'],
    unique: ['u', 'none'], 'zero-terminated': ['z', 'none'], key: ['k', 'required'],
    'field-separator': ['t', 'required'], output: ['o', 'required'], check: ['c', 'optional'],
    sort: ['sort', 'required'], 'random-source': ['random-source', 'required'], debug: ['debug', 'none'],
    'buffer-size': ['S', 'required'], 'temporary-directory': ['T', 'required'], parallel: ['parallel', 'required'],
    'batch-size': ['batch-size', 'required'], 'compress-program': ['compress-program', 'required'],
    'files0-from': ['files0-from', 'required'],
  },
};

const command: Command = async (ctx) => {
  const global: Ordering = { blanksStart: false, blanksEnd: false, dictionary: false, fold: false, nonprinting: false, kind: 'text', reverse: false };
  const keySpecs: string[] = [];
  let tab: number | null = null;
  let unique = false, stable = false, check: 'no' | 'diagnose' | 'quiet' = 'no', zero = false;
  let output: string | undefined;
  let randomSource: string | undefined;
  const files: string[] = [];
  let keys: Key[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`sort: ${message}\nTry 'sort --help' for more information.\n`);
    return 2;
  };
  try {
    const args = ctx.args;
    const setTab = (value: string | undefined) => {
      if (value === undefined) throw new SortUsage("option requires an argument -- 't'");
      const b = encodeLossless(value);
      if (b.length === 0) throw new SortUsage('empty tab');
      if (value === '\\0') { tab = 0; return; }
      if (b.length > 1) throw new SortUsage(`multi-character tab \u2018${value}\u2019`);
      if (tab !== null && tab !== b[0]) throw new SortUsage('incompatible tabs');
      tab = b[0];
    };
    for (const event of getopt(args, SORT_OPTIONS)) {
      if (event.kind === 'error') throw new SortUsage(event.message);
      if (event.kind === 'operand') { files.push(event.value); continue; }
      const { key, value } = event;
      if (key === 'k') keySpecs.push(value!);
      else if (key === 't') setTab(value);
      else if (key === 'o') output = value;
      else if (key === 'c') check = value === 'quiet' || value === 'silent' ? 'quiet' : 'diagnose';
      else if (key === 'C') check = 'quiet';
      else if (key === 'm') { /* inputs merge as a sort of their lines */ }
      else if (key === 's') stable = true;
      else if (key === 'u') unique = true;
      else if (key === 'z') zero = true;
      else if (key === 'sort') {
        // argmatch: the word, or an unambiguous prefix of one (`--sort=gen`).
        const matches = SORT_NAMES.filter((name) => name.startsWith(value!));
        const c = SORT_ORDERS[value!] ?? (matches.length === 1 ? SORT_ORDERS[matches[0]] : undefined);
        if (!c) throw new SortUsage(`${matches.length > 1 ? 'ambiguous' : 'invalid'} argument \u2018${value}\u2019 for \u2018--sort\u2019\nValid arguments are:\n${SORT_NAMES.map((name) => `  - \u2018${name}\u2019`).join('\n')}`, 1);
        applyOrderLetter(global, c, false);
      } else if (key === 'random-source') randomSource = value;
      else if (ORDER_LETTERS.includes(key)) applyOrderLetter(global, key, false);
      // -S, -T, --parallel and the rest tune a sort that runs in memory: read and set aside.
    }
    keys = keySpecs.map((spec) => parseKey(spec, global));
  } catch (error) {
    if (error instanceof SortUsage) return (await usage(error.message), error.status);
    throw error;
  }

  let random: RandomOrder | null = null;
  if (global.kind === 'R' || keys.some((key) => key.kind === 'R')) {
    let salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16));
    if (randomSource !== undefined) {
      try {
        // Its first 16 bytes, read as such: the source may be a device without end (/dev/zero) or a large file.
        const path = resolve(ctx.cwd, randomSource);
        const parts: Uint8Array[] = [];
        for (let got = 0; got < 16;) {
          const chunk = await ctx.vfs.readRange(path, got, 16 - got);
          if (chunk.length === 0) break;
          parts.push(chunk);
          got += chunk.length;
        }
        salt = concatBytes(parts).subarray(0, 16);
      } catch (error) {
        await ctx.stderr.write(`sort: open failed: ${randomSource}: ${strerror(error)}\n`);
        return 2;
      }
      if (salt.length < 16) {
        await ctx.stderr.write(`sort: '${randomSource}': end of file\n`);
        return 2;
      }
    }
    random = new RandomOrder(salt);
  }

  const delim = zero ? 0 : 0x0a;
  const lines: Uint8Array[] = [];
  for (const file of files.length > 0 ? files : ['-']) {
    let bytes: Uint8Array;
    try {
      bytes = await readAllInput(ctx, file);
    } catch (error) {
      await ctx.stderr.write(`sort: cannot read: ${file}: ${strerror(error)}\n`);
      return 2;
    }
    for (const record of splitRecords(bytes, delim).records) lines.push(record);
  }

  const whole: Key = { ...global, startField: 1, startChar: 1, endField: Infinity, endChar: 0 };
  const collated = new Map<Uint8Array, CollationKey>();
  const lineKey = (line: Uint8Array) => {
    let k = collated.get(line);
    if (!k) collated.set(line, k = collationKey(decodeLossless(line)));
    return k;
  };
  // With no -k, the whole line is the one key, under the global ordering.
  const keyCompare = (a: Uint8Array, b: Uint8Array): number => {
    if (keys.length === 0) {
      if (global.kind === 'text' && !global.dictionary && !global.fold && !global.nonprinting && !global.blanksStart) {
        const d = collate(lineKey(a), lineKey(b));
        return global.reverse ? -d : d;
      }
      const [sa, ea] = keyRange(a, whole, tab), [sb, eb] = keyRange(b, whole, tab);
      return compareKey(a.subarray(sa, ea), b.subarray(sb, eb), global, random);
    }
    for (const key of keys) {
      const [sa, ea] = keyRange(a, key, tab), [sb, eb] = keyRange(b, key, tab);
      const d = compareKey(a.subarray(sa, ea), b.subarray(sb, eb), key, random);
      if (d !== 0) return d;
    }
    return 0;
  };
  // Equal keys fall back to the whole line (collation, then bytes), unless -s or -u.
  const lastResort = (a: Uint8Array, b: Uint8Array): number => {
    const d = collate(lineKey(a), lineKey(b)) || compareBytes(a, b);
    return global.reverse ? -d : d;
  };
  const compare = (a: Uint8Array, b: Uint8Array): number => {
    const d = keyCompare(a, b);
    if (d !== 0 || stable || unique) return d;
    return lastResort(a, b);
  };

  if (check !== 'no') {
    for (let i = 1; i < lines.length; i++) {
      const d = compare(lines[i - 1], lines[i]);
      if (d > 0 || (unique && d === 0)) {
        if (check === 'diagnose') {
          const name = files[0] === undefined || files[0] === '-' ? '-' : files[0];
          await ctx.stderr.write(`sort: ${name}:${i + 1}: disorder: `);
          await writeBytes(ctx.stderr as never, concatBytes([lines[i], Uint8Array.of(0x0a)]));
        }
        return 1;
      }
    }
    return 0;
  }

  const indexed = lines.map((line, index) => ({ line, index }));
  indexed.sort((a, b) => compare(a.line, b.line) || a.index - b.index);
  const out: Uint8Array[] = [];
  const end = Uint8Array.of(delim);
  let previous: Uint8Array | null = null;
  for (const { line } of indexed) {
    if (unique && previous !== null && keyCompare(previous, line) === 0) continue;
    out.push(line, end);
    previous = line;
  }
  const bytes = concatBytes(out);
  if (output !== undefined && output !== '-') {
    try { await ctx.vfs.writeFile(resolve(ctx.cwd, output), bytes); }
    catch (error) { await ctx.stderr.write(`sort: open failed: ${output}: ${strerror(error)}\n`); return 2; }
    return 0;
  }
  await writeBytes(ctx.stdout, bytes);
  return 0;
};

export default command;
