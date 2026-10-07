import { getopt, type GetoptSpec } from '../../utils/args.js';
import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { asciiBytes, asciiUpper, concatBytes, readAllInput, skipBlankField, splitRecords, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';

// GNU uniq (coreutils 9.7) on bytes: -c, -d, -D/--all-repeated, --group,
// -u, -i, -f, -s, -w, -z, and an OUTPUT operand. Lines compare as bytes
// (-i folds ASCII case), after skipping -f fields and -s characters, up to
// -w characters.

type Method = 'none' | 'prepend' | 'separate' | 'append' | 'both';


const UNIQ_OPTIONS: GetoptSpec = {
  short: 'cdDuizf:s:w:',
  long: {
    count: ['c', 'none'], repeated: ['d', 'none'], unique: ['u', 'none'], 'ignore-case': ['i', 'none'],
    'zero-terminated': ['z', 'none'], 'all-repeated': ['all-repeated', 'optional'], group: ['group', 'optional'],
    'skip-fields': ['f', 'required'], 'skip-chars': ['s', 'required'], 'check-chars': ['w', 'required'],
  },
};

const command: Command = async (ctx) => {
  let count = false, repeated = false, unique = false, fold = false, zero = false;
  let allRepeated: Method | null = null;
  let group: Method | null = null;
  let skipFields = 0, skipChars = 0, checkChars = Infinity;
  const operands: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`uniq: ${message}\nTry 'uniq --help' for more information.\n`);
    return 1;
  };
  const number = (flag: string, value: string | undefined): number | string => {
    if (value === undefined || !/^\d+$/.test(value)) {
      const what = flag === 'f' ? 'fields to skip' : flag === 's' ? 'bytes to skip' : 'bytes to compare';
      return `${value ?? ''}: invalid number of ${what}`;
    }
    return Number(value);
  };
  for (const event of getopt(ctx.args, UNIQ_OPTIONS)) {
    if (event.kind === 'error') return usage(event.message);
    if (event.kind === 'operand') { operands.push(event.value); continue; }
    const { key, value } = event;
    if (key === 'c') count = true;
    else if (key === 'd') repeated = true;
    else if (key === 'D') allRepeated = 'none';
    else if (key === 'u') unique = true;
    else if (key === 'i') fold = true;
    else if (key === 'z') zero = true;
    else if (key === 'all-repeated') {
      const method = (value ?? 'none') as Method;
      if (!['none', 'prepend', 'separate'].includes(method)) return usage(`invalid argument \u2018${value}\u2019 for \u2018--all-repeated\u2019`);
      allRepeated = method;
    } else if (key === 'group') {
      const method = (value ?? 'separate') as Method;
      if (!['separate', 'prepend', 'append', 'both'].includes(method)) return usage(`invalid argument \u2018${value}\u2019 for \u2018--group\u2019`);
      group = method;
    } else {
      const n = number(key, value);
      if (typeof n === 'string') return usage(n);
      if (key === 'f') skipFields = n; else if (key === 's') skipChars = n; else checkChars = n;
    }
  }
  if (operands.length > 2) return usage(`extra operand \u2018${operands[2]}\u2019`);
  if (count && allRepeated !== null) return usage('printing all duplicated lines and repeat counts is meaningless');
  if (group !== null && (count || repeated || unique || allRepeated !== null)) {
    return usage('--group is mutually exclusive with -c/-d/-D/-u');
  }

  const delim = zero ? 0 : 0x0a;
  let input: Uint8Array;
  try {
    input = await readAllInput(ctx, operands[0]);
  } catch (error) {
    await ctx.stderr.write(`uniq: ${operands[0]}: ${strerror(error)}\n`);
    return 1;
  }

  const lines = splitRecords(input, delim).records;

  const keyOf = (line: Uint8Array): Uint8Array => {
    let at = 0;
    for (let f = 0; f < skipFields && at < line.length; f++) at = skipBlankField(line, at);
    at = Math.min(line.length, at + skipChars);
    return line.subarray(at, checkChars === Infinity ? line.length : Math.min(line.length, at + checkChars));
  };
  const same = (a: Uint8Array, b: Uint8Array): boolean => {
    const ka = keyOf(a), kb = keyOf(b);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i] && !(fold && asciiUpper(ka[i]) === asciiUpper(kb[i]))) return false;
    }
    return true;
  };

  const out: Uint8Array[] = [];
  const end = Uint8Array.of(delim);
  const emit = (line: Uint8Array, n?: number) => {
    if (n !== undefined) out.push(asciiBytes(`${String(n).padStart(7)} `));
    out.push(line, end);
  };
  // Groups of adjacent equal lines.
  const groups: Uint8Array[][] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && same(last[0], line)) last.push(line);
    else groups.push([line]);
  }
  if (group !== null) {
    groups.forEach((g, index) => {
      if ((group === 'prepend' || group === 'both') || (index > 0 && group !== 'append')) out.push(end);
      for (const line of g) out.push(line, end);
      if (group === 'append' || (group === 'both' && index === groups.length - 1)) out.push(end);
    });
  } else if (allRepeated !== null) {
    let printed = 0;
    for (const g of groups) {
      if (g.length < 2) continue;
      if (allRepeated === 'prepend' || (allRepeated === 'separate' && printed > 0)) out.push(end);
      for (const line of g) out.push(line, end);
      printed++;
    }
  } else {
    for (const g of groups) {
      if (repeated && g.length < 2) continue;
      if (unique && g.length > 1) continue;
      emit(g[0], count ? g.length : undefined);
    }
  }

  const bytes = concatBytes(out);
  if (operands[1] !== undefined && operands[1] !== '-') {
    try {
      await ctx.vfs.writeFile(resolve(ctx.cwd, operands[1]), bytes);
    } catch (error) {
      await ctx.stderr.write(`uniq: ${operands[1]}: ${strerror(error)}\n`);
      return 1;
    }
    return 0;
  }
  await writeBytes(ctx.stdout, bytes);
  return 0;
};

export default command;
