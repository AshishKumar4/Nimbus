import { yieldToEventLoop } from '../../utils/event-loop.js';
/** What one write carries: GNU yes fills a BUFSIZ buffer with whole lines. */
const BUFFER_CHARS = 8192;
/**
 * Buffers written between event-loop turns: one turn per 512 KiB. A reader
 * that closes the pipe ends yes at its next write; a Ctrl-C or `kill` needs a
 * turn to arrive. A turn per buffer made every 8 KiB written to a file in a
 * Durable Object its own storage commit (utils/event-loop.ts).
 */
const BUFFERS_PER_TURN = 64;
const command = async (ctx) => {
    const line = (ctx.args.length > 0 ? ctx.args.join(' ') : 'y') + '\n';
    // Whole lines only, so no write ends mid-line; at least one for a long line.
    const chunk = line.repeat(Math.max(1, Math.floor(BUFFER_CHARS / line.length)));
    for (let written = 0; !ctx.signal.aborted; written++) {
        await ctx.stdout.write(chunk);
        if (written % BUFFERS_PER_TURN === BUFFERS_PER_TURN - 1)
            await yieldToEventLoop();
    }
    return 0;
};
export default command;
