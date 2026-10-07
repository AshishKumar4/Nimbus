import type { Command } from '../types.js';
import { waitForAbortOrTimeout } from '../signal.js';
import { exitCodeForAbortSignal } from '../../shell/signals.js';

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    await ctx.stderr.write('sleep: missing operand\n');
    return 1;
  }

  const seconds = parseFloat(ctx.args[0]);
  if (isNaN(seconds) || seconds < 0) {
    await ctx.stderr.write(`sleep: invalid time interval '${ctx.args[0]}'\n`);
    return 1;
  }

  const ms = Math.round(seconds * 1000);

  // An abort ends the sleep with its signal's status: 130 for Ctrl-C, 143 for SIGTERM.
  if (ctx.signal.aborted || (await waitForAbortOrTimeout(ctx.signal, ms)) === 'aborted') {
    return exitCodeForAbortSignal(ctx.signal);
  }
  return 0;
};

export default command;
