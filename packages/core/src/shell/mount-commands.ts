/**
 * `df`, `mount` and `/proc/mounts`: three views of one table, the filesystem
 * authority's mount listing (`NimbusFilesystemAuthority.mounts`). An embedder
 * wrapping the authority adds its mounts there and all three show them.
 */
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type {
  NimbusFilesystemAuthority,
  NimbusMountEntry,
  NimbusMountUsage,
} from '../runtime/os-contracts.js';
import { resolveVfsPath } from '../vfs/path.js';
import { fsErrorMessage } from './unix-commands.js';

/** The mount `path` (absolute, normalized) lives on: the longest mount point
 *  containing it; of equal ones the later, which shadows the earlier. */
function mountOf(entries: readonly NimbusMountEntry[], path: string): NimbusMountEntry | null {
  let found: NimbusMountEntry | null = null;
  for (const entry of entries) {
    const point = entry.mountPoint;
    const contains = point === '/' || path === point || path.startsWith(`${point}/`);
    if (contains && (found === null || point.length >= found.mountPoint.length)) found = entry;
  }
  return found;
}

/** The kernel's escaping in /proc/mounts: space, tab, newline and backslash as octal. */
function procField(value: string): string {
  return value.replace(/[ \t\n\\]/g, (ch) => `\\${ch.charCodeAt(0).toString(8).padStart(3, '0')}`);
}

/** `/proc/mounts`, in the kernel's format. Usage is not part of it. */
export function formatProcMounts(entries: readonly NimbusMountEntry[]): string {
  return entries
    .map((entry) => `${procField(entry.source)} ${procField(entry.mountPoint)} ${procField(entry.type)} ${procField(entry.options?.join(',') || 'rw')} 0 0\n`)
    .join('');
}

const HUMAN_UNITS = 'KMGTPEZYRQ';

/**
 * gnulib's human_readable with df -h's options: powers of 1024, rounded up,
 * one decimal below 10.
 */
function humanSize(bytes: number): string {
  const base = 1024;
  let amount = bytes;
  let tenths = 0;
  let rounding = 0;
  let exponent = 0;
  if (amount >= base) {
    do {
      const r10 = (amount % base) * 10 + tenths;
      const r2 = (r10 % base) * 2 + (rounding >> 1);
      amount = Math.floor(amount / base);
      tenths = Math.floor(r10 / base);
      rounding = r2 < base ? (r2 !== 0 ? 1 : 0) : 2 + (base < r2 ? 1 : 0);
      exponent++;
    } while (base <= amount && exponent < HUMAN_UNITS.length);
    if (amount < 10) {
      if (rounding > 0) {
        tenths++;
        rounding = 0;
        if (tenths === 10) { amount++; tenths = 0; }
      }
      if (amount < 10) return `${amount}.${tenths}${HUMAN_UNITS[exponent - 1]}`;
    }
  }
  if (tenths + rounding > 0) {
    amount++;
    if (amount === base && exponent < HUMAN_UNITS.length) return `1.0${HUMAN_UNITS[exponent]}`;
  }
  return exponent === 0 ? String(amount) : `${amount}${HUMAN_UNITS[exponent - 1]}`;
}

interface DfOptions { all: boolean; human: boolean; printType: boolean; operands: string[] }

const DF_USAGE = `Usage: df [OPTION]... [FILE]...
Show information about the file system on which each FILE resides,
or all file systems by default.

  -a, --all             include file systems without usage
  -h, --human-readable  print sizes in powers of 1024 (e.g., 1023M)
  -k                    like --block-size=1K (the default)
  -T, --print-type      print file system type
      --help            display this help and exit
`;

function parseDf(args: readonly string[]): DfOptions | { error: string } | 'help' {
  const options: DfOptions = { all: false, human: false, printType: false, operands: [] };
  let optionsDone = false;
  for (const arg of args) {
    if (optionsDone || arg === '-' || !arg.startsWith('-')) { options.operands.push(arg); continue; }
    if (arg === '--') { optionsDone = true; continue; }
    if (arg.startsWith('--')) {
      if (arg === '--all') options.all = true;
      else if (arg === '--human-readable') options.human = true;
      else if (arg === '--print-type') options.printType = true;
      else if (arg === '--help') return 'help';
      else return { error: `unrecognized option '${arg}'` };
      continue;
    }
    for (const flag of arg.slice(1)) {
      if (flag === 'a') options.all = true;
      else if (flag === 'h') options.human = true;
      else if (flag === 'T') options.printType = true;
      else if (flag === 'k') options.human = false;
      else return { error: `invalid option -- '${flag}'` };
    }
  }
  return options;
}

type Align = 'left' | 'right';

/** GNU df's table: each column as wide as its widest cell (with df's
 *  minimums), one space apart, the last column unpadded. */
function renderTable(rows: readonly (readonly string[])[], minimums: readonly number[], aligns: readonly Align[]): string {
  const widths = minimums.map((min, col) => Math.max(min, ...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => {
    if (col === row.length - 1) return cell;
    return aligns[col] === 'left' ? cell.padEnd(widths[col]) : cell.padStart(widths[col]);
  }).join(' ')).join('\n') + '\n';
}

function dfRow(entry: NimbusMountEntry, usage: NimbusMountUsage | null, options: DfOptions): string[] {
  const amount = (bytes: number): string => options.human ? humanSize(bytes) : String(Math.ceil(bytes / 1024));
  const row = [entry.source];
  if (options.printType) row.push(entry.type);
  if (usage === null) {
    row.push('-', '-', '-', '-');
  } else {
    const total = usage.used + usage.available;
    row.push(
      amount(usage.size),
      amount(usage.used),
      amount(usage.available),
      total === 0 ? '-' : `${Math.ceil((usage.used * 100) / total)}%`,
    );
  }
  row.push(entry.mountPoint);
  return row;
}

function createDfCommand(filesystem: NimbusFilesystemAuthority): Command {
  return async (ctx: CommandContext) => {
    const parsed = parseDf(ctx.args);
    if (parsed === 'help') { await ctx.stdout.write(DF_USAGE); return 0; }
    if ('error' in parsed) {
      await ctx.stderr.write(`df: ${parsed.error}\nTry 'df --help' for more information.\n`);
      return 1;
    }
    const entries = filesystem.mounts?.(ctx.cred) ?? [];
    let status = 0;
    let selected: { entry: NimbusMountEntry; explicit: boolean }[];
    if (parsed.operands.length === 0) {
      selected = entries.map((entry) => ({ entry, explicit: false }));
    } else {
      selected = [];
      for (const operand of parsed.operands) {
        const path = `/${resolveVfsPath(operand, ctx.cwd)}`;
        try {
          await ctx.vfs.stat(path);
        } catch (error) {
          await ctx.stderr.write(`df: ${operand}: ${fsErrorMessage(error)}\n`);
          status = 1;
          continue;
        }
        const entry = mountOf(entries, path);
        if (entry === null) {
          await ctx.stderr.write(`df: ${operand}: cannot find the mount it resides on\n`);
          status = 1;
          continue;
        }
        selected.push({ entry, explicit: true });
      }
    }
    const usages = await Promise.all(selected.map(({ entry }) => entry.usage()));
    const rows: string[][] = [];
    selected.forEach(({ entry, explicit }, index) => {
      const usage = usages[index];
      if (usage === null && !explicit && !parsed.all) return;
      rows.push(dfRow(entry, usage, parsed));
    });
    if (rows.length === 0) {
      if (status === 0) {
        await ctx.stderr.write('df: no file systems processed\n');
        status = 1;
      }
      return status;
    }
    const header = parsed.human
      ? ['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on']
      : ['Filesystem', '1K-blocks', 'Used', 'Available', 'Use%', 'Mounted on'];
    const minimums = [14, 5, 5, 5, 4, 0];
    const aligns: Align[] = ['left', 'right', 'right', 'right', 'right', 'left'];
    if (parsed.printType) {
      header.splice(1, 0, 'Type');
      minimums.splice(1, 0, 4);
      aligns.splice(1, 0, 'left');
    }
    await ctx.stdout.write(renderTable([header, ...rows], minimums, aligns));
    return status;
  };
}

const MOUNT_USAGE = `Usage:
 mount [-l] [-t <type>[,<type>...]]

List the mounted filesystems. Mounts come from the host; this shell does
not mount or unmount.
`;

function createMountCommand(filesystem: NimbusFilesystemAuthority): Command {
  return async (ctx: CommandContext) => {
    let types: Set<string> | null = null;
    const operands: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-h' || arg === '--help') { await ctx.stdout.write(MOUNT_USAGE); return 0; }
      if (arg === '-l' || arg === '--show-labels') continue;
      if (arg === '-t' || arg === '--types' || arg.startsWith('--types=') || (arg.startsWith('-t') && arg.length > 2)) {
        const value = arg === '-t' || arg === '--types'
          ? ctx.args[++i]
          : arg.startsWith('--types=') ? arg.slice('--types='.length) : arg.slice(2);
        if (value === undefined) {
          await ctx.stderr.write(`mount: option requires an argument -- 't'\nTry 'mount --help' for more information.\n`);
          return 1;
        }
        types = new Set(value.split(','));
        continue;
      }
      if (arg.startsWith('-')) {
        await ctx.stderr.write(`mount: unsupported option '${arg}'\nTry 'mount --help' for more information.\n`);
        return 1;
      }
      operands.push(arg);
    }
    if (operands.length > 0) {
      await ctx.stderr.write(`mount: ${operands.at(-1)}: mounting is not supported here; mounts come from the host\n`);
      return 32;
    }
    const lines = (filesystem.mounts?.(ctx.cred) ?? [])
      .filter((entry) => types === null || types.has(entry.type))
      .map((entry) => `${entry.source} on ${entry.mountPoint} type ${entry.type} (${entry.options?.join(',') || 'rw'})\n`);
    await ctx.stdout.write(lines.join(''));
    return 0;
  };
}

/** `df` and `mount` over `filesystem`'s listing, for the credential of the calling process. */
export function registerMountCommands(registry: CommandRegistry, filesystem: NimbusFilesystemAuthority): void {
  registry.register('df', createDfCommand(filesystem));
  registry.register('mount', createMountCommand(filesystem));
}
