import type { Command } from '../types.js';

const command: Command = async (ctx) => {
  const args = ctx.args;

  if (args.length === 0) {
    await ctx.stderr.write('Usage: seq [-s SEP] [FIRST [INCR]] LAST\n');
    await ctx.stderr.write('Print a sequence of numbers.\n');
    return 1;
  }

  let first = 1;
  let increment = 1;
  let last: number;
  let separator = '\n';
  let equalWidth = false;

  // Parse -s / -w options
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-s' && i + 1 < args.length) {
      separator = args[++i];
    } else if (args[i] === '-w') {
      equalWidth = true;
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 1) {
    last = parseFloat(positional[0]);
  } else if (positional.length === 2) {
    first = parseFloat(positional[0]);
    last = parseFloat(positional[1]);
  } else {
    first = parseFloat(positional[0]);
    increment = parseFloat(positional[1]);
    last = parseFloat(positional[2]);
  }

  if (isNaN(first) || isNaN(increment) || isNaN(last)) {
    await ctx.stderr.write('seq: invalid argument\n');
    return 1;
  }

  if (increment === 0) {
    await ctx.stderr.write('seq: zero increment\n');
    return 1;
  }

  const isInt = Number.isInteger(first) && Number.isInteger(increment) && Number.isInteger(last);
  const steps = Math.floor((last - first) / increment + 1e-10);
  if (steps < 0) return 0;
  const format = (n: number) => (isInt ? String(Math.round(n)) : String(n));
  // -w pads to the wider of the first and the last number printed.
  const width = equalWidth && isInt
    ? Math.max(format(first).length, format(first + steps * increment).length)
    : 0;

  // One number per write, so `seq 1 1000000000 | head` ends with its reader.
  for (let i = 0; i <= steps; i++) {
    if (ctx.signal.aborted) return 130;
    const text = format(first + i * increment).padStart(width, '0');
    await ctx.stdout.write(i === steps ? `${text}\n` : text + separator);
  }

  return 0;
};

export default command;
