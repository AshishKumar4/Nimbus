/** What one write carries: GNU yes fills a BUFSIZ buffer with whole lines. */
const BUFFER_CHARS = 8192;
const command = async (ctx) => {
    const line = (ctx.args.length > 0 ? ctx.args.join(' ') : 'y') + '\n';
    // Whole lines only, so no write ends mid-line; at least one for a long line.
    const chunk = line.repeat(Math.max(1, Math.floor(BUFFER_CHARS / line.length)));
    while (!ctx.signal.aborted) {
        await ctx.stdout.write(chunk);
        // One event-loop turn per buffer, not per line: an abort (the reader
        // closing the pipe) is still seen within a buffer.
        // (core targets ES2022, which has no Promise.withResolvers.)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return 0;
};
export default command;
