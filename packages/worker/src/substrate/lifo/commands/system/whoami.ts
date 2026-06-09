import type { Command } from '../types.js';

const command: Command = async (ctx) => {
  ctx.stdout.write((ctx.env.USER || 'user') + '\n');
  return 0;
};

export default command;
