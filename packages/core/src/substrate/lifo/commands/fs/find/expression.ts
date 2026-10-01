/**
 * find's command line, parsed as findutils 4.10 parses it (parser.c, tree.c):
 * leading options, start points, then an expression built in two passes. The
 * first turns arguments into a list of predicates, inserting the implicit
 * -a and running each predicate's own parser (which may stat a reference
 * file or look up a user, and may fail the command); the second builds the
 * tree by precedence, with GNU's messages for every malformed shape.
 *
 * GNU predicates this find does not implement are refused by name rather
 * than skipped: skipping one answers a different question.
 */

import type { ProcessStat, ProcessView } from '../../../../../runtime/process-files.js';
import { isVfsError, VFS_STRERROR } from '../../../../../vfs/vfs-error.js';
import { findUnixGroup, findUnixUser } from '../../../../../shell/unix-accounts.js';
import { globMatch } from '../../../utils/glob.js';
import { resolve } from '../../../utils/path.js';
import { adjustMode, compileMode } from '../../../utils/mode-change.js';
import { compileFormat, type CompiledFormat, type FileTypeLetter } from './format.js';
import { FindUsageError, quote } from './errors.js';

export type Comparison = 'lt' | 'eq' | 'gt';
export type SymlinkMode = 'P' | 'H' | 'L';
export type TimeField = 'atime' | 'ctime' | 'mtime';
/** -type's letters: a mode's, and Solaris's door, which GNU on Linux refuses. */
export type TypeLetter = FileTypeLetter | 'D';

export type Primary =
  | { readonly kind: 'true' | 'false' | 'empty' | 'nouser' | 'nogroup' | 'prune' | 'quit' | 'delete' }
  | { readonly kind: 'name' | 'path' | 'lname'; readonly pattern: string; readonly fold: boolean }
  /** -type, or with `target` -xtype: the type of what the other kind of stat sees. */
  | { readonly kind: 'type'; readonly types: Readonly<Partial<Record<TypeLetter, true>>>; readonly target: boolean }
  | { readonly kind: 'size'; readonly cmp: Comparison; readonly count: number; readonly unit: number }
  /** -[acm]time, -[acm]min: findutils' pred_timewindow against `reference` (ms), `window` seconds wide. */
  | { readonly kind: 'time'; readonly field: TimeField; readonly cmp: Comparison; readonly reference: number; readonly window: number }
  /** -used: the same window over how long after its last change the file was last read. */
  | { readonly kind: 'used'; readonly cmp: Comparison; readonly reference: number }
  | { readonly kind: 'newer'; readonly field: TimeField; readonly reference: number }
  | { readonly kind: 'perm'; readonly match: 'exact' | 'all' | 'any'; readonly file: number; readonly directory: number }
  | { readonly kind: 'number'; readonly field: 'uid' | 'gid' | 'nlink' | 'ino'; readonly cmp: Comparison; readonly value: number }
  | { readonly kind: 'access'; readonly mode: number }
  | { readonly kind: 'samefile'; readonly dev: number; readonly ino: number }
  | { readonly kind: 'print'; readonly terminator: '\n' | '\0' }
  | { readonly kind: 'printf'; readonly format: CompiledFormat }
  | { readonly kind: 'exec'; readonly argv: readonly string[]; readonly batch: boolean; readonly inDirectory: boolean };

export type Expression =
  | { readonly kind: 'and' | 'or' | 'comma'; readonly left: Expression; readonly right: Expression }
  | { readonly kind: 'not'; readonly operand: Expression }
  | { readonly kind: 'primary'; readonly primary: Primary };

export interface FindPlan {
  readonly kind: 'walk';
  readonly startPoints: readonly string[];
  readonly expression: Expression;
  readonly symlinks: SymlinkMode;
  readonly maxDepth: number;
  readonly minDepth: number;
  readonly depthFirst: boolean;
  readonly sameDevice: boolean;
  /** -ignore_readdir_race: a file gone between the listing and its use is not an error. */
  readonly ignoreVanished: boolean;
}

/** -help and -version answer at once, whatever else is on the line. */
export type FindCommand = FindPlan | { readonly kind: 'info'; readonly text: string };

export interface ParseEnvironment {
  readonly vfs: ProcessView;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** When find started, in ms: the origin of every relative time. */
  readonly now: number;
  /** GNU's default for -warn: whether standard input is a terminal. */
  readonly warnings: boolean;
  readonly version: string;
  warn(message: string): void;
}

const DAY_SECONDS = 86400;

/** findutils' looks_like_expression: what ends the start points (`leading`) or must begin each expression argument. */
function looksLikeExpression(arg: string, leading: boolean): boolean {
  switch (arg[0]) {
    case '-': return arg.length > 1;
    case ')': case ',': return arg.length === 1 && !leading;
    case '!': case '(': return arg.length === 1;
    default: return false;
  }
}

type BinaryKind = 'and' | 'or' | 'comma';
const PRECEDENCE: Readonly<Record<BinaryKind | 'not', number>> = { comma: 1, or: 2, and: 3, not: 4 };

/** One entry of GNU's predicate list; `artificial` marks the `( … ) -print` find wraps an action-less expression in. */
type Item =
  | { readonly type: 'primary'; readonly name: string; readonly primary: Primary; readonly action: boolean }
  | { readonly type: 'not'; readonly name: string }
  | { readonly type: 'binary'; readonly name: string; readonly op: BinaryKind }
  | { readonly type: 'open' | 'close'; readonly name: string; readonly artificial: boolean };

/** How a predicate's parser failed: GNU then names the argument it stopped at, or says one is missing. */
const MALFORMED = Symbol('malformed');

/** The parse table's argument classes, which decide GNU's global-option warning. */
type ArgClass = 'option' | 'positional' | 'other';

interface Entry {
  readonly argClass: ArgClass;
  parse(parser: Parser, name: string): Promise<typeof MALFORMED | void>;
}

/** GNU predicates refused by name, with why. */
const NOT_IMPLEMENTED: Readonly<Record<string, string>> = {
  fstype: 'file system types are not reported',
  ls: 'block counts are not reported',
  fls: 'block counts are not reported',
  fprint: 'output files are not supported',
  fprint0: 'output files are not supported',
  fprintf: 'output files are not supported',
  'files0-from': 'start points from a file are not supported',
  ok: 'there is no prompt to confirm on',
  okdir: 'there is no prompt to confirm on',
  regex: 'regular expressions are not supported',
  iregex: 'regular expressions are not supported',
  regextype: 'regular expressions are not supported',
};

class Parser {
  readonly items: Item[] = [{ type: 'open', name: '(', artificial: true }];
  symlinks: SymlinkMode = 'P';
  maxDepth = Infinity;
  minDepth = 0;
  depthFirst = false;
  explicitDepth = false;
  sameDevice = false;
  ignoreVanished = false;
  warnings: boolean;
  private firstNonOption: string | null = null;
  /** Midnight-relative days begin here (findutils' cur_day_start): a day before now, or today's midnight after -daystart. */
  private dayStart: number;
  private fullDays = false;
  private pos: number;

  constructor(
    readonly args: readonly string[],
    start: number,
    readonly startPoints: readonly string[],
    readonly environment: ParseEnvironment,
  ) {
    this.pos = start;
    this.warnings = environment.warnings;
    this.dayStart = environment.now - DAY_SECONDS * 1000;
  }

  next(): string | undefined {
    return this.args[this.pos++];
  }

  get position(): number {
    return this.pos;
  }

  set position(value: number) {
    this.pos = value;
  }

  private get last(): Item {
    return this.items[this.items.length - 1];
  }

  /** Before a primary, a `!` or a `(`, the implicit -a GNU inserts after a primary or `)`. */
  private joinWithAnd(): void {
    const last = this.last;
    if (last.type === 'primary' || last.type === 'close') this.items.push({ type: 'binary', name: '-a', op: 'and' });
  }

  addPrimary(name: string, primary: Primary, action = false): void {
    this.joinWithAnd();
    this.items.push({ type: 'primary', name, primary, action });
  }

  addNot(name: string): void {
    this.joinWithAnd();
    this.items.push({ type: 'not', name });
  }

  addOpen(name: string): void {
    this.joinWithAnd();
    this.items.push({ type: 'open', name, artificial: false });
  }

  addClose(name: string): void {
    this.items.push({ type: 'close', name, artificial: false });
  }

  addBinary(name: string, op: BinaryKind): void {
    this.items.push({ type: 'binary', name, op });
  }

  /** An option evaluates as true where it stands, as GNU's no-op predicate does. */
  addOption(name: string): void {
    this.addPrimary(name, { kind: 'true' });
  }

  warn(message: string): void {
    if (this.warnings) this.environment.warn(message);
  }

  /** GNU's warning for a global option after a test, and its record of the first non-option. */
  noteClass(name: string, argClass: ArgClass): void {
    if (argClass === 'option') {
      if (this.firstNonOption !== null) {
        this.warn(`warning: you have specified the global option ${name} after the argument ${this.firstNonOption}, but global options are not positional, i.e., ${name} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.`);
      }
    } else if (argClass === 'other' && this.firstNonOption === null) {
      this.firstNonOption = name;
    }
  }

  daystart(): void {
    if (this.fullDays) return;
    // Midnight in the session's zone (UTC) of the day after dayStart, which is today.
    const tomorrow = this.dayStart + DAY_SECONDS * 1000;
    this.dayStart = tomorrow - (tomorrow % (DAY_SECONDS * 1000));
    this.fullDays = true;
  }

  /** findutils' parse_time (-atime, -ctime, -mtime) and do_parse_xmin (-amin, -cmin, -mmin). */
  relativeTime(argument: string, unitSeconds: number, days: boolean): { cmp: Comparison; reference: number } | null {
    let origin = days ? this.dayStart : this.dayStart + DAY_SECONDS * 1000;
    // `-n` days counts to the end of today.
    if (days && argument.startsWith('-')) origin += (DAY_SECONDS - 1) * 1000;
    return relativeTimestamp(argument, origin, unitSeconds);
  }

  /** stat as the walk will (links per -P/-H/-L, the command line counting as depth 0), failing the command as GNU does. */
  async statReference(path: string): Promise<ProcessStat> {
    const absolute = resolve(this.environment.cwd, path);
    const vfs = this.environment.vfs;
    try {
      let stat: ProcessStat | null = null;
      if (this.symlinks !== 'P') {
        // A dangling link is examined itself (findutils' fallback_stat).
        stat = await vfs.stat(absolute).catch((error: unknown) => {
          if (isVfsError(error, 'ENOTDIR')) return null;
          throw error;
        });
      }
      stat ??= await vfs.stat(absolute, { follow: false });
      if (stat !== null) return stat;
      throw new FindUsageError(`${quote(path)}: ${VFS_STRERROR.ENOENT}`);
    } catch (error) {
      if (isVfsError(error)) throw new FindUsageError(`${quote(path)}: ${VFS_STRERROR[error.code]}`);
      throw error;
    }
  }

  plan(expression: Expression): FindPlan {
    return {
      kind: 'walk',
      startPoints: this.startPoints,
      expression,
      symlinks: this.symlinks,
      maxDepth: this.maxDepth,
      minDepth: this.minDepth,
      depthFirst: this.depthFirst,
      sameDevice: this.sameDevice,
      ignoreVanished: this.ignoreVanished,
    };
  }
}

/** findutils' get_relative_timestamp: the comparison is inverted, as a larger age is an earlier time. */
function relativeTimestamp(argument: string, origin: number, unitSeconds: number): { cmp: Comparison; reference: number } | null {
  const sign = argument[0];
  const cmp: Comparison = sign === '+' ? 'lt' : sign === '-' ? 'gt' : 'eq';
  const text = sign === '+' || sign === '-' ? argument.slice(1) : argument;
  // strtod's decimal form, which takes a sign of its own (`+-1` is accepted).
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  return { cmp, reference: origin - Number(text) * unitSeconds * 1000 };
}

/** findutils' get_num: an optional +/- and a decimal integer. */
function parseNumber(argument: string): { cmp: Comparison; value: number } | null {
  const sign = argument[0];
  const cmp: Comparison = sign === '+' ? 'gt' : sign === '-' ? 'lt' : 'eq';
  const digits = sign === '+' || sign === '-' ? argument.slice(1) : argument;
  if (!/^\s*\d+$/.test(digits)) return null;
  const value = BigInt(digits.trim());
  return value > 0xffff_ffff_ffff_ffffn ? null : { cmp, value: Number(value) };
}

const SIZE_UNITS: Readonly<Record<string, number>> = { b: 512, c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };
const TYPE_LETTERS: Readonly<Record<string, TypeLetter>> = { b: 'b', c: 'c', d: 'd', p: 'p', f: 'f', l: 'l', s: 's', D: 'D' };

function typeSet(letters: string, predicate: string): Partial<Record<TypeLetter, true>> {
  if (letters === '') throw new FindUsageError(`Arguments to ${predicate} should contain at least one letter`);
  const types: Partial<Record<TypeLetter, true>> = {};
  for (let i = 0; i < letters.length; i++) {
    const letter = TYPE_LETTERS[letters[i]];
    if (letter === undefined) throw new FindUsageError(`Unknown argument to ${predicate}: ${letters[i]}`);
    if (letter === 'D') throw new FindUsageError(`${predicate} D is not supported because Solaris doors are not supported on the platform find was compiled on.`);
    if (types[letter]) throw new FindUsageError(`Duplicate file type '${letter}' in the argument list to ${predicate}.`);
    types[letter] = true;
    if (i + 1 < letters.length) {
      if (letters[i + 1] !== ',') throw new FindUsageError(`Must separate multiple arguments to ${predicate} using: ','`);
      i++;
      if (i + 1 === letters.length) throw new FindUsageError(`Last file type in list argument to ${predicate} is missing, i.e., list is ending on: ','`);
    }
  }
  return types;
}

const R_OK = 4, W_OK = 2, X_OK = 1;

/** An account lookup where an unreadable /etc/passwd or /etc/group means no such account, as getpwnam reports it. */
async function accountOrNull<T>(lookup: Promise<T | null>): Promise<T | null> {
  try {
    return await lookup;
  } catch (error) {
    if (isVfsError(error)) return null;
    throw error;
  }
}

function option(apply: (parser: Parser) => void): Entry {
  return { argClass: 'option', parse: async (parser, name) => { apply(parser); parser.addOption(name); } };
}

function positional(apply: (parser: Parser) => void): Entry {
  return { argClass: 'positional', parse: async (parser, name) => { apply(parser); parser.addOption(name); } };
}

function test(parse: (parser: Parser, name: string) => Promise<typeof MALFORMED | void>): Entry {
  return { argClass: 'other', parse };
}

function noArgument(primary: Primary, action = false): Entry {
  return test(async (parser, name) => { parser.addPrimary(name, primary, action); });
}

/** -depth, and -delete, which implies it. */
function visitDepthFirst(parser: Parser): void {
  parser.depthFirst = true;
}

function depthLimit(set: (parser: Parser, depth: number) => void): Entry {
  return {
    argClass: 'option',
    parse: async (parser, name) => {
      const value = parser.next();
      if (value === undefined) return MALFORMED;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new FindUsageError(`Expected a positive decimal integer argument to ${name}, but got ${quote(value)}`);
      }
      set(parser, Number(value));
      parser.addOption(name);
    },
  };
}

function pattern(kind: 'name' | 'path' | 'lname', fold: boolean, alternative: string | null): Entry {
  return test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    if (alternative !== null && value.includes('/') && value !== '/') {
      parser.warn(`warning: '${name}' matches against basenames only, but the given pattern contains a directory separator ('/'), thus the expression will evaluate to false all the time.  Did you mean '${alternative}'?`);
    }
    if (kind === 'path' && value.endsWith('/')) {
      const candidates = parser.startPoints.length > 0 ? parser.startPoints : ['.'];
      const feasible = candidates.some((start) => fold ? globMatch(value.toLowerCase(), start.toLowerCase()) : globMatch(value, start));
      if (!feasible) parser.environment.warn(`warning: ${name} ${value} will not match anything because it ends with /.`);
    }
    parser.addPrimary(name, { kind, pattern: fold ? value.toLowerCase() : value, fold });
  });
}

function relativeTime(field: TimeField, unitSeconds: number, days: boolean): Entry {
  return test(async (parser, name) => {
    const start = parser.position;
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const time = parser.relativeTime(value, unitSeconds, days);
    if (time === null) {
      parser.position = start;
      return MALFORMED;
    }
    parser.addPrimary(name, { kind: 'time', field, cmp: time.cmp, reference: time.reference, window: days ? DAY_SECONDS : unitSeconds });
  });
}

function newer(field: TimeField): Entry {
  return test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const stat = await parser.statReference(value);
    parser.addPrimary(name, { kind: 'newer', field, reference: stat.mtimeMs });
  });
}

function numeric(field: 'uid' | 'gid' | 'nlink' | 'ino'): Entry {
  return test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const number = parseNumber(value);
    if (number === null) throw new FindUsageError(`non-numeric argument to ${name}: ${quote(value)}`);
    parser.addPrimary(name, { kind: 'number', field, cmp: number.cmp, value: number.value });
  });
}

function access(mode: number): Entry {
  return noArgument({ kind: 'access', mode });
}

function exec(inDirectory: boolean): Entry {
  return test(async (parser, name) => {
    const start = parser.position;
    if (parser.args[start] === undefined) return MALFORMED;
    if (inDirectory) checkPathSafety(name, parser.environment.env.PATH);
    let end = start;
    let batch = false;
    let braces = 0;
    let braceArg = '';
    let sawBraces = false;
    for (; end < parser.args.length && parser.args[end] !== ';'; end++) {
      // `+` ends the command only right after a {} argument.
      if (parser.args[end] === '+' && sawBraces) {
        batch = true;
        break;
      }
      sawBraces = parser.args[end].includes('{}');
      if (sawBraces) {
        braces++;
        braceArg = parser.args[end];
        if (end === start && inDirectory) {
          throw new FindUsageError('You may not use {} within the utility name for -execdir and -okdir, because this is a potential security problem.');
        }
      }
    }
    if (end === start || end >= parser.args.length) {
      parser.position = end;
      return MALFORMED;
    }
    if (batch) {
      if (braces > 1) throw new FindUsageError(`Only one instance of {} is supported with ${name} ... +`);
      if (braceArg !== '{}') throw new FindUsageError(`In '${name} ... {} +' the '{}' must appear by itself, but you specified ${quote(braceArg)}`);
    }
    // A batch's command is its arguments before the {} that ends it.
    const argv = parser.args.slice(start, batch ? end - 1 : end);
    parser.position = end + 1;
    parser.addPrimary(name, { kind: 'exec', argv, batch, inDirectory }, true);
  });
}

/** findutils' check_path_safety: -execdir runs a command found on PATH from the file's own directory. */
function checkPathSafety(action: string, path: string | undefined): void {
  if (path === undefined) return;
  for (const entry of path.split(':')) {
    if (entry === '' || entry === '.') {
      throw new FindUsageError(`The current directory is included in the PATH environment variable, which is insecure in combination with the ${action} action of find.  Please remove the current directory from your $PATH (that is, remove ".", doubled colons, or leading or trailing colons)`);
    }
    if (!entry.startsWith('/')) {
      throw new FindUsageError(`The relative path ${quote(entry)} is included in the PATH environment variable, which is insecure in combination with the ${action} action of find.  Please remove that entry from $PATH`);
    }
  }
}

const HELP = `Usage: find [-H] [-L] [-P] [-Olevel] [starting-point...] [expression]

Default path is the current directory; default expression is -print.
Expression may consist of: operators, options, tests, and actions.

Operators (decreasing precedence; -and is implicit where no others are given):
      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2
      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2

Positional options (always true):
      -daystart -follow -nowarn -warn

Normal options (always true, specified before other expressions):
      -depth -ignore_readdir_race -maxdepth LEVELS -mindepth LEVELS
      -mount -noignore_readdir_race -noleaf -xdev

Tests (N can be +N or -N or N):
      -amin N -anewer FILE -atime N -cmin N -cnewer FILE -ctime N
      -empty -executable -false -gid N -group NAME -ilname PATTERN
      -iname PATTERN -inum N -ipath PATTERN -iwholename PATTERN
      -links N -lname PATTERN -mmin N -mtime N -name PATTERN -newer FILE
      -newerXY REFERENCE -nogroup -nouser -path PATTERN
      -perm [-/]MODE -readable -samefile FILE -size N[bcwkMG] -true
      -type [bcdpfls] -uid N -used N -user NAME -wholename PATTERN
      -writable -xtype [bcdpfls]

Actions:
      -delete -exec COMMAND ; -exec COMMAND {} + -execdir COMMAND ;
      -execdir COMMAND {} + -print -print0 -printf FORMAT -prune -quit

Not supported here: -context -files0-from -fls -fprint -fprint0 -fprintf
      -fstype -iregex -ls -ok -okdir -regex -regextype, and -D
`;

const TABLE: Readonly<Record<string, Entry>> = {
  '!': { argClass: 'other', parse: async (parser, name) => { parser.addNot(name); } },
  not: { argClass: 'other', parse: async (parser, name) => { parser.addNot(name); } },
  '(': { argClass: 'other', parse: async (parser, name) => { parser.addOpen(name); } },
  ')': { argClass: 'other', parse: async (parser, name) => { parser.addClose(name); } },
  ',': { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'comma'); } },
  a: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'and'); } },
  and: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'and'); } },
  o: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'or'); } },
  or: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'or'); } },

  d: option((parser) => {
    parser.warn('warning: the -d option is deprecated; please use -depth instead, because the latter is a POSIX-compliant feature.');
    visitDepthFirst(parser);
    parser.explicitDepth = true;
  }),
  depth: option((parser) => { visitDepthFirst(parser); parser.explicitDepth = true; }),
  maxdepth: depthLimit((parser, depth) => { parser.maxDepth = depth; }),
  mindepth: depthLimit((parser, depth) => { parser.minDepth = depth; }),
  mount: option((parser) => { parser.sameDevice = true; }),
  xdev: option((parser) => { parser.sameDevice = true; }),
  noleaf: option(() => undefined),
  ignore_readdir_race: option((parser) => { parser.ignoreVanished = true; }),
  noignore_readdir_race: option((parser) => { parser.ignoreVanished = false; }),
  daystart: positional((parser) => parser.daystart()),
  follow: positional((parser) => { parser.symlinks = 'L'; }),
  warn: positional((parser) => { parser.warnings = true; }),
  nowarn: positional((parser) => { parser.warnings = false; }),

  true: noArgument({ kind: 'true' }),
  false: noArgument({ kind: 'false' }),
  empty: noArgument({ kind: 'empty' }),
  nouser: noArgument({ kind: 'nouser' }),
  nogroup: noArgument({ kind: 'nogroup' }),
  readable: access(R_OK),
  writable: access(W_OK),
  executable: access(X_OK),
  name: pattern('name', false, '-wholename'),
  iname: pattern('name', true, '-iwholename'),
  path: pattern('path', false, null),
  wholename: pattern('path', false, null),
  ipath: pattern('path', true, null),
  iwholename: pattern('path', true, null),
  lname: pattern('lname', false, null),
  ilname: pattern('lname', true, null),
  type: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    parser.addPrimary(name, { kind: 'type', types: typeSet(value, '-type'), target: false });
  }),
  xtype: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    parser.addPrimary(name, { kind: 'type', types: typeSet(value, '-xtype'), target: true });
  }),
  size: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    if (value === '') throw new FindUsageError('invalid null argument to -size');
    const suffix = value[value.length - 1];
    const unit = SIZE_UNITS[suffix];
    if (unit === undefined && !(suffix >= '0' && suffix <= '9')) throw new FindUsageError(`invalid -size type \`${suffix}'`);
    const digits = unit === undefined ? value : value.slice(0, -1);
    const number = parseNumber(digits);
    if (number === null) throw new FindUsageError(`Invalid argument \`${digits}${unit === undefined ? '' : suffix}' to -size`);
    parser.addPrimary(name, { kind: 'size', cmp: number.cmp, count: number.value, unit: unit ?? 512 });
  }),
  atime: relativeTime('atime', DAY_SECONDS, true),
  ctime: relativeTime('ctime', DAY_SECONDS, true),
  mtime: relativeTime('mtime', DAY_SECONDS, true),
  amin: relativeTime('atime', 60, false),
  cmin: relativeTime('ctime', 60, false),
  mmin: relativeTime('mtime', 60, false),
  used: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const time = relativeTimestamp(value, 0, DAY_SECONDS);
    if (time === null) throw new FindUsageError(`Invalid argument ${value} to -used`);
    parser.addPrimary(name, { kind: 'used', cmp: time.cmp, reference: time.reference });
  }),
  newer: newer('mtime'),
  anewer: newer('atime'),
  cnewer: newer('ctime'),
  perm: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const match = value[0] === '-' ? 'all' : value[0] === '/' ? 'any' : 'exact';
    const changes = compileMode(match === 'exact' ? value : value.slice(1));
    // +MODE was once -perm /MODE; GNU now refuses the numeric form rather than guess.
    if (changes === null || (value[0] === '+' && value[1] >= '0' && value[1] < '8')) {
      throw new FindUsageError(`invalid mode ${quote(value)}`);
    }
    const file = adjustMode(0, false, 0, changes);
    const directory = adjustMode(0, true, 0, changes);
    if (match === 'any' && file === 0 && directory === 0) {
      parser.environment.warn(`warning: you have specified a mode pattern ${value} (which is equivalent to /000). The meaning of -perm /000 has now been changed to be consistent with -perm -000; that is, while it used to match no files, it now matches all files.`);
      parser.addPrimary(name, { kind: 'perm', match: 'all', file, directory });
      return;
    }
    parser.addPrimary(name, { kind: 'perm', match, file, directory });
  }),
  uid: numeric('uid'),
  gid: numeric('gid'),
  links: numeric('nlink'),
  inum: numeric('ino'),
  user: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const user = await accountOrNull(findUnixUser(parser.environment.vfs, value));
    // getpwnam first, as GNU asks; only a name nobody has may be a uid.
    const uid = user?.name === value ? user.uid : /^\d+$/.test(value) ? Number(value) : undefined;
    if (uid === undefined) throw new FindUsageError(`invalid user name or UID argument to -user: ${quote(value)}`);
    parser.addPrimary(name, { kind: 'number', field: 'uid', cmp: 'eq', value: uid });
  }),
  group: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const group = await accountOrNull(findUnixGroup(parser.environment.vfs, value));
    const gid = group?.name === value ? group.gid : /^\d+$/.test(value) ? Number(value) : undefined;
    if (gid === undefined) throw new FindUsageError(`invalid group name or GID argument to -group: ${quote(value)}`);
    parser.addPrimary(name, { kind: 'number', field: 'gid', cmp: 'eq', value: gid });
  }),
  samefile: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    const stat = await parser.statReference(value);
    parser.addPrimary(name, { kind: 'samefile', dev: stat.dev, ino: stat.ino });
  }),
  context: test(async (parser) => {
    if (parser.args[parser.position] === undefined) return MALFORMED;
    throw new FindUsageError('invalid predicate -context: SELinux is not enabled.');
  }),

  print: noArgument({ kind: 'print', terminator: '\n' }, true),
  print0: noArgument({ kind: 'print', terminator: '\0' }, true),
  printf: test(async (parser, name) => {
    const value = parser.next();
    if (value === undefined) return MALFORMED;
    parser.addPrimary(name, { kind: 'printf', format: compileFormat(value, (message) => parser.environment.warn(message)) }, true);
  }),
  prune: noArgument({ kind: 'prune' }),
  quit: noArgument({ kind: 'quit' }),
  delete: test(async (parser, name) => {
    visitDepthFirst(parser);
    parser.addPrimary(name, { kind: 'delete' }, true);
  }),
  exec: exec(false),
  execdir: exec(true),
};

/** -newerXY: X and Y from a, c, m (B, the birth time, is not recorded); Y may be t, a date. */
async function parseNewerXY(parser: Parser, name: string): Promise<boolean> {
  const x = name[6];
  const y = name[7];
  if (x === 'B' || y === 'B') {
    parser.environment.warn('This system does not provide a way to find the birth time of a file.');
    return false;
  }
  const fields: Readonly<Record<string, TimeField>> = { a: 'atime', c: 'ctime', m: 'mtime' };
  const field = fields[x];
  if (field === undefined || (fields[y] === undefined && y !== 't')) return false;
  const reference = parser.next();
  if (reference === undefined) throw new FindUsageError(`The ${quote(name)} test needs an argument`);
  if (y === 't') {
    throw new FindUsageError(`invalid predicate \`${name}': dates are not supported here; use -newer${x}m with a reference file`);
  }
  const stat = await parser.statReference(reference);
  const time = y === 'a' ? stat.atimeMs : y === 'c' ? stat.ctimeMs : stat.mtimeMs;
  parser.addPrimary(name, { kind: 'newer', field, reference: time });
  return true;
}

function precedence(item: Item): number {
  return item.type === 'binary' ? PRECEDENCE[item.op] : item.type === 'not' ? PRECEDENCE.not : 0;
}

/** findutils' get_expr / scan_rest over the predicate list. */
class TreeBuilder {
  private index = 0;

  constructor(private readonly items: readonly Item[]) {}

  get remaining(): Item | undefined {
    return this.items[this.index];
  }

  expression(prevPrecedence: number, prev: Item | null): Expression {
    const item = this.items[this.index];
    if (item === undefined) throw new FindUsageError('invalid expression');
    let result: Expression;
    switch (item.type) {
      case 'binary':
        throw new FindUsageError(`invalid expression; you have used a binary operator '${item.name}' with nothing before it.`);
      case 'close':
        if (prev === null) throw new FindUsageError(`invalid expression: expected expression before closing parentheses '${item.name}'.`);
        if ((prev.type === 'not' || prev.type === 'binary') && !item.artificial) {
          throw new FindUsageError(`expected an expression between '${prev.name}' and ')'`);
        }
        if (item.artificial) throw new FindUsageError(`expected an expression after '${prev.name}'`);
        throw new FindUsageError("invalid expression; you have too many ')'");
      case 'primary':
        this.index++;
        result = { kind: 'primary', primary: item.primary };
        break;
      case 'not':
        this.index++;
        result = { kind: 'not', operand: this.expression(PRECEDENCE.not, item) };
        break;
      case 'open': {
        const following = this.items[this.index + 1];
        if (following === undefined || (following.type === 'close' && following.artificial)) {
          throw new FindUsageError(`invalid expression; expected to find a ')' but didn't see one. Perhaps you need an extra predicate after '${item.name}'`);
        }
        this.index++;
        if (following.type === 'close') {
          if (item.artificial) throw new FindUsageError(`invalid expression: expected expression before closing parentheses '${following.name}'.`);
          throw new FindUsageError('invalid expression; empty parentheses are not allowed.');
        }
        result = this.expression(0, item);
        const close = this.items[this.index];
        if (close === undefined || close.type !== 'close') {
          throw new FindUsageError("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
        }
        this.index++;
        break;
      }
    }
    const next = this.items[this.index];
    if (next !== undefined && precedence(next) > prevPrecedence) return this.continueWith(result, prevPrecedence);
    return result;
  }

  /** findutils' scan_rest: fold every following operator that binds tighter than the caller's. */
  private continueWith(head: Expression, prevPrecedence: number): Expression {
    let tree = head;
    for (let item = this.items[this.index]; item !== undefined && precedence(item) > prevPrecedence; item = this.items[this.index]) {
      if (item.type !== 'binary') throw new FindUsageError('invalid expression');
      this.index++;
      tree = { kind: item.op, left: tree, right: this.expression(PRECEDENCE[item.op], item) };
    }
    return tree;
  }
}

/** Whether any predicate in the list is an action, which turns off the default -print. */
function hasAction(items: readonly Item[]): boolean {
  return items.some((item) => item.type === 'primary' && item.action);
}

/** findutils' process_optimisation_option: the level only reorders side-effect-free tests, which changes no result. */
function checkOptimisationLevel(level: string): void {
  if (level === '') throw new FindUsageError('The -O option must be immediately followed by a decimal integer');
  if (!(level[0] >= '0' && level[0] <= '9')) throw new FindUsageError('Please specify a decimal number immediately after -O');
  if (!/^\d+$/.test(level)) throw new FindUsageError(`Invalid optimisation level ${level}`);
  const value = BigInt(level);
  if (value > 0xffff_ffff_ffff_ffffn) throw new FindUsageError(`Invalid optimisation level ${level}: Numerical result out of range`);
  if (value > 65535n) {
    throw new FindUsageError(`Optimisation level ${value} is too high.  If you want to find files very quickly, consider using GNU locate.`);
  }
}

/** Parse find's arguments into what to walk and what to evaluate at each file. */
export async function parseFindCommand(args: readonly string[], environment: ParseEnvironment): Promise<FindCommand> {
  let symlinks: SymlinkMode = 'P';
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-H' || arg === '-L' || arg === '-P') symlinks = arg === '-H' ? 'H' : arg === '-L' ? 'L' : 'P';
    else if (arg === '--') { i++; break; }
    else if (arg === '-D') {
      if (i + 1 >= args.length) throw new FindUsageError('Missing argument after the -D option.', ["Try 'find --help' for more information."]);
      throw new FindUsageError('the -D debug option is not supported here');
    } else if (arg.startsWith('-O')) checkOptimisationLevel(arg.slice(2));
    else break;
  }
  const startIndex = i;
  while (i < args.length && !looksLikeExpression(args[i], true)) i++;
  const parser = new Parser(args, i, args.slice(startIndex, i), environment);
  parser.symlinks = symlinks;

  while (parser.position < args.length) {
    const arg = args[parser.position];
    if (!looksLikeExpression(arg, false)) {
      const exists = await environment.vfs.exists(resolve(environment.cwd, arg)).catch((error: unknown) => {
        if (isVfsError(error)) return false;
        throw error;
      });
      const last = parser.items[parser.items.length - 1];
      throw new FindUsageError(
        `paths must precede expression: \`${arg}'`,
        exists ? [`find: possible unquoted pattern after predicate \`${last.name}'?`] : [],
      );
    }
    if (arg.length === 8 && arg.startsWith('-newer')) {
      parser.noteClass(arg, 'other');
      parser.position++;
      if (!(await parseNewerXY(parser, arg))) throw new FindUsageError(`invalid predicate \`${arg}'`);
      continue;
    }
    const key = arg.startsWith('-') ? arg.slice(1) : arg;
    if (key === 'help' || key === '-help') return { kind: 'info', text: HELP };
    if (key === 'version' || key === '-version') return { kind: 'info', text: `find (nimbus findutils) ${environment.version}\n` };
    if (Object.hasOwn(NOT_IMPLEMENTED, key)) throw new FindUsageError(`invalid predicate \`${arg}': ${NOT_IMPLEMENTED[key]}`);
    if (!Object.hasOwn(TABLE, key)) throw new FindUsageError(`unknown predicate \`${arg}'`);
    const entry = TABLE[key];
    parser.noteClass(arg, entry.argClass);
    parser.position++;
    if ((await entry.parse(parser, arg)) === MALFORMED) {
      const at = args[parser.position];
      throw new FindUsageError(at === undefined ? `missing argument to \`${arg}'` : `invalid argument \`${at}' to \`${arg}'`);
    }
  }

  const userItems = parser.items.slice(1);
  let items: Item[];
  if (userItems.length === 0) {
    items = [{ type: 'primary', name: '-print', primary: { kind: 'print', terminator: '\n' }, action: true }];
  } else if (hasAction(userItems)) {
    items = userItems;
  } else {
    // `( expression ) -print`, joined by the -a GNU inserts after any `)`.
    items = [
      ...parser.items,
      { type: 'close', name: ')', artificial: true },
      { type: 'binary', name: '-a', op: 'and' },
      { type: 'primary', name: '-print', primary: { kind: 'print', terminator: '\n' }, action: true },
    ];
  }
  const prunes = items.some((item) => item.type === 'primary' && item.primary.kind === 'prune');
  const deletes = items.some((item) => item.type === 'primary' && item.primary.kind === 'delete');
  if (prunes && deletes && !parser.explicitDepth) {
    throw new FindUsageError('The -delete action automatically turns on -depth, but -prune does nothing when -depth is in effect.  If you want to carry on anyway, just explicitly use the -depth option.');
  }

  const builder = new TreeBuilder(items);
  const expression = builder.expression(0, null);
  const leftover = builder.remaining;
  if (leftover !== undefined) {
    if (leftover.type === 'close') throw new FindUsageError("you have too many ')'");
    throw new FindUsageError(`unexpected extra predicate '${leftover.name}'`);
  }
  return parser.plan(expression);
}
