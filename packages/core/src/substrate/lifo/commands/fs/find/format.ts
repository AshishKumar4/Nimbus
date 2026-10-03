/**
 * find's -printf: the format compiled once into segments (findutils'
 * insert_fprintf), and each segment rendered for one file (do_fprintf).
 *
 * GNU works in bytes: an escape names a byte, and a field's width and
 * precision count bytes. So does this.
 */

import type { ProcessStat } from '../../../../../runtime/process-files.js';
import type { VfsDirentType } from '../../../../../vfs/vfs.js';
import { FindUsageError } from './errors.js';

const encoder = new TextEncoder();

/** printf's flags, width and precision as GNU passes them through (it never takes `0` as a flag; a width starting with 0 is). */
interface FieldSpec {
  readonly left: boolean;
  readonly plus: boolean;
  readonly space: boolean;
  readonly alternate: boolean;
  readonly zero: boolean;
  readonly width: number;
  readonly precision: number | null;
}

type PathDirectiveKind = 'name' | 'dirname' | 'path' | 'relative' | 'start' | 'depth';
type StatDirectiveKind = 'target-type' | 'link' | 'size' | 'inode' | 'links' | 'uid' | 'gid' | 'device' | 'user' | 'group' | 'mode' | 'mode-string';

/** The directives this find renders; a time directive carries its strftime letter. */
export type Directive =
  | { readonly kind: PathDirectiveKind }
  | { readonly kind: 'type' }
  | { readonly kind: StatDirectiveKind }
  | { readonly kind: 'ctime-format'; readonly field: TimeField }
  | { readonly kind: 'time'; readonly field: TimeField; readonly letter: string };

export type TimeField = 'atime' | 'ctime' | 'mtime';

export type FormatSegment =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  /** `\c`: what came before is printed, and nothing after it, for this file. */
  | { readonly kind: 'stop' }
  | { readonly kind: 'field'; readonly field: FieldSpec; readonly directive: Directive };

export interface CompiledFormat {
  readonly segments: readonly FormatSegment[];
  /**
   * What rendering reads beyond the path (findutils' need_type, need_stat):
   * a file whose type or stat cannot be had prints nothing.
   */
  readonly needs: 'path' | 'type' | 'stat';
}

/** The directives GNU knows and Nimbus has no facts for: block counts, sparseness, file system type, SELinux, birth time. */
const UNSUPPORTED_DIRECTIVES: Readonly<Record<string, true>> = { b: true, k: true, S: true, F: true, Z: true, B: true };

/** Directives answered from the path and depth alone; %y needs the type; every other one reads the stat. */
type PathDirective = { readonly kind: PathDirectiveKind };
type StatDirective = Exclude<Directive, PathDirective | { readonly kind: 'type' }>;
const PATH_DIRECTIVES: Readonly<Record<PathDirectiveKind, true>> = {
  name: true, dirname: true, path: true, relative: true, start: true, depth: true,
};

function isPathDirective(directive: Directive): directive is PathDirective {
  return Object.hasOwn(PATH_DIRECTIVES, directive.kind);
}

function directiveFor(letter: string, timeLetter: string | undefined): Directive | null {
  switch (letter) {
    case 'f': return { kind: 'name' };
    case 'h': return { kind: 'dirname' };
    case 'p': return { kind: 'path' };
    case 'P': return { kind: 'relative' };
    case 'H': return { kind: 'start' };
    case 'd': return { kind: 'depth' };
    case 'y': return { kind: 'type' };
    case 'Y': return { kind: 'target-type' };
    case 'l': return { kind: 'link' };
    case 's': return { kind: 'size' };
    case 'i': return { kind: 'inode' };
    case 'n': return { kind: 'links' };
    case 'U': return { kind: 'uid' };
    case 'G': return { kind: 'gid' };
    case 'D': return { kind: 'device' };
    case 'u': return { kind: 'user' };
    case 'g': return { kind: 'group' };
    case 'm': return { kind: 'mode' };
    case 'M': return { kind: 'mode-string' };
    case 'a': return { kind: 'ctime-format', field: 'atime' };
    case 'c': return { kind: 'ctime-format', field: 'ctime' };
    case 't': return { kind: 'ctime-format', field: 'mtime' };
    case 'A': return timeLetter === undefined ? null : { kind: 'time', field: 'atime', letter: timeLetter };
    case 'C': return timeLetter === undefined ? null : { kind: 'time', field: 'ctime', letter: timeLetter };
    case 'T': return timeLetter === undefined ? null : { kind: 'time', field: 'mtime', letter: timeLetter };
    default: return null;
  }
}

const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };

/**
 * Compile a -printf format. Warnings GNU prints and goes on from (an unknown
 * escape or directive is printed as written) go to `warn`; what GNU refuses
 * throws, and so does a directive GNU knows but Nimbus cannot answer.
 */
export function compileFormat(format: string, warn: (message: string) => void): CompiledFormat {
  const segments: FormatSegment[] = [];
  let text = '';
  const flushText = (): void => {
    if (text !== '') segments.push({ kind: 'bytes', bytes: encoder.encode(text) });
    text = '';
  };
  const pushByte = (byte: number): void => {
    flushText();
    segments.push({ kind: 'bytes', bytes: Uint8Array.of(byte) });
  };
  let needs: CompiledFormat['needs'] = 'path';

  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === '\\') {
      const next = format[i + 1];
      if (next === 'c') {
        flushText();
        segments.push({ kind: 'stop' });
        return { segments, needs };
      }
      if (next === undefined) {
        warn("warning: escape `\\' followed by nothing at all");
        text += '\\';
        continue;
      }
      if (next >= '0' && next <= '7') {
        let value = 0;
        let used = 0;
        while (used < 3 && format[i + 1 + used] !== undefined && format[i + 1 + used] >= '0' && format[i + 1 + used] <= '7') {
          value = value * 8 + Number(format[i + 1 + used]);
          used++;
        }
        pushByte(value & 0xff);
        i += used;
        continue;
      }
      const escaped = ESCAPES[next];
      if (escaped === undefined) {
        warn(`warning: unrecognized escape \`\\${next}'`);
        text += `\\${next}`;
        i++;
        continue;
      }
      pushByte(escaped);
      i++;
      continue;
    }
    if (ch !== '%') {
      text += ch;
      continue;
    }

    if (i + 1 >= format.length) throw new FindUsageError(`error: ${format.slice(i)} at end of format string`);
    if (format[i + 1] === '%') {
      text += '%';
      i++;
      continue;
    }
    // Flags, then a width (a leading 0 in it is printf's zero flag), then a precision.
    let j = i + 1;
    let left = false, plus = false, space = false, alternate = false;
    for (; '-+ #'.includes(format[j] ?? 'x'); j++) {
      if (format[j] === '-') left = true;
      else if (format[j] === '+') plus = true;
      else if (format[j] === ' ') space = true;
      else alternate = true;
    }
    const widthStart = j;
    while (format[j] !== undefined && format[j] >= '0' && format[j] <= '9') j++;
    const widthText = format.slice(widthStart, j);
    let precision: number | null = null;
    if (format[j] === '.') {
      const precisionStart = ++j;
      while (format[j] !== undefined && format[j] >= '0' && format[j] <= '9') j++;
      precision = Number(format.slice(precisionStart, j) || '0');
    }
    const field: FieldSpec = {
      left, plus, space, alternate,
      zero: widthText.startsWith('0'),
      width: widthText === '' ? 0 : Number(widthText),
      precision,
    };
    const letter = format[j];
    // GNU's own message here quotes the string's terminating NUL.
    if (letter === undefined) throw new FindUsageError("error: the format directive `%\0' is reserved for future use");
    const written = format.slice(i, j);

    if (letter === '%') {
      // GNU prints a flagged %% as its text up to the second %: `%5%` is `%5`.
      text += written;
      i = j;
      continue;
    }
    if ('{[('.includes(letter)) {
      throw new FindUsageError(`error: the format directive \`%${letter}' is reserved for future use`);
    }
    const isTime = 'ABCT'.includes(letter);
    if (isTime && format[j + 1] === undefined) {
      warn(`warning: format directive \`%${letter}' should be followed by another character`);
      text += written + letter;
      i = j;
      continue;
    }
    if (UNSUPPORTED_DIRECTIVES[letter]) {
      throw new FindUsageError(`error: the format directive \`%${letter}' is not supported here`);
    }
    const directive = directiveFor(letter, isTime ? format[j + 1] : undefined);
    if (directive === null) {
      warn(`warning: unrecognized format directive \`%${letter}'`);
      text += written + letter;
      i = j;
      continue;
    }
    flushText();
    segments.push({ kind: 'field', field, directive });
    if (directive.kind === 'type' && needs === 'path') needs = 'type';
    else if (directive.kind !== 'type' && !isPathDirective(directive)) needs = 'stat';
    i = isTime ? j + 1 : j;
  }
  flushText();
  return { segments, needs };
}

/** One file's facts, as a -printf directive asks for them. */
export interface FormatSubject {
  readonly path: string;
  readonly start: string;
  readonly depth: number;
  /** The file's stat as the walk sees it (links followed or not, per -P/-H/-L); present when the format needs it. */
  readonly stat: ProcessStat | null;
  /** %y: the file's type letter; present when the format needs it. */
  readonly type: FileTypeLetter | null;
  /** readlink of the file, for %l on a link; null when it cannot be read (and the failure has been reported). */
  linkTarget(): Promise<string | null>;
  /** %Y's letter for a link: its target's type, N when it dangles, L for a loop. */
  targetType(): Promise<string>;
  userName(uid: number): Promise<string | null>;
  groupName(gid: number): Promise<string | null>;
}

const S_IFMT = 0o170000;

/** The -type letters a mode can have. */
export type FileTypeLetter = 'f' | 'd' | 'l' | 's' | 'b' | 'c' | 'p';

const FILE_TYPE_LETTERS: ReadonlyMap<number, FileTypeLetter> = new Map<number, FileTypeLetter>([
  [0o100000, 'f'], [0o040000, 'd'], [0o120000, 'l'], [0o140000, 's'],
  [0o060000, 'b'], [0o020000, 'c'], [0o010000, 'p'],
]);

const DIRENT_TYPE_LETTERS: Readonly<Record<Exclude<VfsDirentType, 'unknown'>, FileTypeLetter>> = {
  file: 'f', directory: 'd', symlink: 'l', character: 'c', block: 'b', fifo: 'p', socket: 's',
};

/** The -type letter readdir's d_type gives an entry, or null where it cannot tell. */
export function direntTypeLetter(type: VfsDirentType): FileTypeLetter | null {
  return type === 'unknown' ? null : DIRENT_TYPE_LETTERS[type];
}

/**
 * findutils' mode_to_filetype: the -type letter for a file. A stat's mode
 * carries the type bits where its backend sets them (a device's do); where
 * it holds only the permission bits, the stat's own type stands in for them.
 */
export function fileTypeLetter(stat: Pick<ProcessStat, 'mode' | 'type'>): FileTypeLetter {
  return FILE_TYPE_LETTERS.get(stat.mode & S_IFMT) ?? (stat.type === 'directory' ? 'd' : stat.type === 'symlink' ? 'l' : 'f');
}

const MODE_STRING_TYPES: Readonly<Record<string, string>> = { f: '-', d: 'd', l: 'l', s: 's', b: 'b', c: 'c', p: 'p' };

/** gnulib's filemodestring, for %M. */
function modeString(stat: ProcessStat): string {
  const mode = stat.mode;
  const typeChar = MODE_STRING_TYPES[fileTypeLetter(stat)];
  const triad = (read: number, write: number, exec: number, special: number, set: string): string =>
    ((mode & read) ? 'r' : '-')
    + ((mode & write) ? 'w' : '-')
    + ((mode & special) ? ((mode & exec) ? set : set.toUpperCase()) : ((mode & exec) ? 'x' : '-'));
  return typeChar
    + triad(0o400, 0o200, 0o100, 0o4000, 's')
    + triad(0o040, 0o020, 0o010, 0o2000, 's')
    + triad(0o004, 0o002, 0o001, 0o1000, 't');
}

/** gnulib's base_name: the last component, with a run of trailing slashes kept as one. */
export function baseName(path: string): string {
  let start = 0;
  while (path[start] === '/') start++;
  if (start === path.length) return path === '' ? '' : '/';
  let base = start;
  let lastWasSlash = false;
  for (let i = start; i < path.length; i++) {
    if (path[i] === '/') lastWasSlash = true;
    else if (lastWasSlash) {
      base = i;
      lastWasSlash = false;
    }
  }
  let end = path.length;
  while (end > base + 1 && path[end - 1] === '/') end--;
  return path.slice(base, end < path.length ? end + 1 : end);
}

/** %h, exactly as findutils computes it (its trailing-slash rule keeps one slash of `a//`). */
function leadingDirectories(path: string): string {
  let pname = path;
  let s = pname.length - 1;
  while (s >= 0 && pname[s] === '/') s--;
  if (s > 0 && pname[s + 1] === '/') pname = pname.slice(0, s + 1);
  const slash = pname.lastIndexOf('/');
  return slash === -1 ? '.' : pname.slice(0, slash);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (value: number, width: number, fill = '0'): string => String(value).padStart(width, fill);

/** The fraction GNU appends to a time with seconds: nine digits of nanoseconds and a trailing zero. */
function nanosecondSuffix(ms: number): string {
  const nanoseconds = Math.round((ms - Math.floor(ms / 1000) * 1000) * 1e6);
  return `.${pad(Math.min(nanoseconds, 999_999_999), 9)}0`;
}

const DAY_MS = 86_400_000;

/** ISO 8601 week-based year and week (%G, %V): the week's Thursday decides the year, and week 1 holds January 4. */
function isoWeek(date: Date): { year: number; week: number } {
  const mondayBased = (day: number): number => (day + 6) % 7;
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayBased(date.getUTCDay()) + 3);
  const year = new Date(thursday).getUTCFullYear();
  const january4 = Date.UTC(year, 0, 4);
  const firstMonday = january4 - mondayBased(new Date(january4).getUTCDay()) * DAY_MS;
  return { year, week: 1 + Math.floor((thursday - firstMonday) / (7 * DAY_MS)) };
}

/** glibc's strftime in the C locale, in the session's zone (UTC); an unknown conversion is printed as written. */
function strftime(letter: string, date: Date): string {
  const hours = date.getUTCHours();
  const yearDay = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS);
  const weekday = date.getUTCDay();
  switch (letter) {
    case 'a': return WEEKDAYS[weekday];
    case 'A': return WEEKDAY_NAMES[weekday];
    case 'b': case 'h': return MONTHS[date.getUTCMonth()];
    case 'B': return MONTH_NAMES[date.getUTCMonth()];
    case 'c': return `${WEEKDAYS[weekday]} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate(), 2, ' ')} ${strftime('T', date)} ${date.getUTCFullYear()}`;
    case 'C': return pad(Math.floor(date.getUTCFullYear() / 100), 2);
    case 'd': return pad(date.getUTCDate(), 2);
    case 'D': case 'x': return `${strftime('m', date)}/${strftime('d', date)}/${strftime('y', date)}`;
    case 'e': return pad(date.getUTCDate(), 2, ' ');
    case 'F': return `${date.getUTCFullYear()}-${strftime('m', date)}-${strftime('d', date)}`;
    case 'g': return pad(isoWeek(date).year % 100, 2);
    case 'G': return String(isoWeek(date).year);
    case 'H': return pad(hours, 2);
    case 'I': return pad(hours % 12 || 12, 2);
    case 'j': return pad(yearDay + 1, 3);
    case 'k': return pad(hours, 2, ' ');
    case 'l': return pad(hours % 12 || 12, 2, ' ');
    case 'm': return pad(date.getUTCMonth() + 1, 2);
    case 'M': return pad(date.getUTCMinutes(), 2);
    case 'n': return '\n';
    case 'p': return hours < 12 ? 'AM' : 'PM';
    case 'P': return hours < 12 ? 'am' : 'pm';
    case 'r': return `${strftime('I', date)}:${strftime('M', date)}:${strftime('S', date)} ${strftime('p', date)}`;
    case 'R': return `${strftime('H', date)}:${strftime('M', date)}`;
    case 's': return String(Math.floor(date.getTime() / 1000));
    case 'S': return pad(date.getUTCSeconds(), 2);
    case 't': return '\t';
    case 'T': case 'X': return `${strftime('H', date)}:${strftime('M', date)}:${strftime('S', date)}`;
    case 'u': return String(weekday === 0 ? 7 : weekday);
    case 'U': return pad(Math.floor((yearDay + 7 - weekday) / 7), 2);
    case 'V': return pad(isoWeek(date).week, 2);
    case 'w': return String(weekday);
    case 'W': return pad(Math.floor((yearDay + 7 - ((weekday + 6) % 7)) / 7), 2);
    case 'y': return pad(date.getUTCFullYear() % 100, 2);
    case 'Y': return String(date.getUTCFullYear());
    case 'z': return '+0000';
    case 'Z': return 'UTC';
    case '%': return '%';
    default: return `%${letter}`;
  }
}

/** findutils' format_date: a strftime letter, `@` (seconds since the epoch) or `+` (date+time), with the fraction where a time has seconds. */
function formatDate(ms: number, letter: string): string {
  if (letter === '@') return `${Math.floor(ms / 1000)}${nanosecondSuffix(ms)}`;
  const date = new Date(Math.floor(ms / 1000) * 1000);
  if (letter === '+') return `${strftime('F', date)}+${strftime('T', date)}${nanosecondSuffix(ms)}`;
  const text = strftime(letter, date);
  return letter === 'S' || letter === 'T' || letter === 'X' ? text + nanosecondSuffix(ms) : text;
}

/** findutils' ctime_format, for %a, %c and %t. */
function ctimeFormat(ms: number): string {
  const date = new Date(Math.floor(ms / 1000) * 1000);
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate(), 2, ' ')} ${strftime('T', date)}${nanosecondSuffix(ms)} ${pad(date.getUTCFullYear(), 4)}`;
}

/** printf's %s: precision truncates, width pads with spaces (bytes, as C counts them). */
function formatString(value: string, field: FieldSpec): Uint8Array {
  let bytes = encoder.encode(value);
  if (field.precision !== null && bytes.length > field.precision) bytes = bytes.subarray(0, field.precision);
  if (bytes.length >= field.width) return bytes;
  const out = new Uint8Array(field.width).fill(0x20);
  out.set(bytes, field.left ? 0 : field.width - bytes.length);
  return out;
}

/** printf's %d and %o for a non-negative integer, with every flag C gives them. */
function formatInteger(value: number, field: FieldSpec, radix: 8 | 10): Uint8Array {
  let digits = value.toString(radix);
  if (field.precision !== null) digits = field.precision === 0 && value === 0 ? '' : digits.padStart(field.precision, '0');
  if (radix === 8 && field.alternate && !digits.startsWith('0')) digits = `0${digits}`;
  const sign = radix === 10 ? (field.plus ? '+' : field.space ? ' ' : '') : '';
  let text = sign + digits;
  if (text.length < field.width) {
    if (field.left) text = text.padEnd(field.width, ' ');
    else if (field.zero && field.precision === null) text = sign + digits.padStart(field.width - sign.length, '0');
    else text = text.padStart(field.width, ' ');
  }
  return encoder.encode(text);
}

function timeOf(stat: ProcessStat, field: TimeField): number {
  return field === 'atime' ? stat.atimeMs : field === 'ctime' ? stat.ctimeMs : stat.mtimeMs;
}

function renderPathField(directive: PathDirective, field: FieldSpec, subject: FormatSubject): Uint8Array {
  switch (directive.kind) {
    case 'name': return formatString(baseName(subject.path), field);
    case 'dirname': return formatString(leadingDirectories(subject.path), field);
    case 'path': return formatString(subject.path, field);
    case 'start': return formatString(subject.start, field);
    case 'depth': return formatInteger(subject.depth, field, 10);
    case 'relative': {
      if (subject.depth === 0) return formatString('', field);
      const rest = subject.path.slice(subject.start.length);
      return formatString(rest.startsWith('/') ? rest.slice(1) : rest, field);
    }
  }
}

async function renderStatField(directive: StatDirective, field: FieldSpec, stat: ProcessStat, subject: FormatSubject): Promise<Uint8Array> {
  switch (directive.kind) {
    case 'target-type': {
      const letter = fileTypeLetter(stat);
      return formatString(letter === 'l' ? await subject.targetType() : letter, field);
    }
    case 'link': return formatString(fileTypeLetter(stat) === 'l' ? (await subject.linkTarget()) ?? '' : '', field);
    case 'size': return formatString(String(stat.size), field);
    case 'inode': return formatString(String(stat.ino), field);
    case 'links': return formatString(String(stat.nlink), field);
    case 'uid': return formatString(String(stat.uid), field);
    case 'gid': return formatString(String(stat.gid), field);
    case 'device': return formatString(String(stat.dev), field);
    case 'user': return formatString((await subject.userName(stat.uid)) ?? String(stat.uid), field);
    case 'group': return formatString((await subject.groupName(stat.gid)) ?? String(stat.gid), field);
    case 'mode': return formatInteger(stat.mode & 0o7777, field, 8);
    case 'mode-string': return formatString(modeString(stat), field);
    case 'ctime-format': return formatString(ctimeFormat(timeOf(stat, directive.field)), field);
    case 'time': return formatString(formatDate(timeOf(stat, directive.field), directive.letter), field);
  }
}

/** One file's -printf output; `subject.stat` must be present when the format needs it. */
export async function renderFormat(format: CompiledFormat, subject: FormatSubject): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const segment of format.segments) {
    if (segment.kind === 'stop') break;
    if (segment.kind === 'bytes') {
      out.push(segment.bytes);
    } else if (isPathDirective(segment.directive)) {
      out.push(renderPathField(segment.directive, segment.field, subject));
    } else if (segment.directive.kind === 'type') {
      if (subject.type === null) throw new Error('find: %y was rendered without the file\'s type');
      out.push(formatString(subject.type, segment.field));
    } else {
      if (subject.stat === null) throw new Error('find: a -printf directive that reads the stat was rendered without one');
      out.push(await renderStatField(segment.directive, segment.field, subject.stat, subject));
    }
  }
  return out;
}
