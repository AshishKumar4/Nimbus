const command = async (ctx) => {
    if (ctx.args.length === 0) {
        ctx.stderr.write('sleep: missing operand\n');
        return 1;
    }
    const seconds = parseFloat(ctx.args[0]);
    if (isNaN(seconds) || seconds < 0) {
        ctx.stderr.write(`sleep: invalid time interval '${ctx.args[0]}'\n`);
        return 1;
    }
    const ms = Math.round(seconds * 1000);
    if (ctx.signal.aborted) {
        return 130;
    }
    await new Promise((resolve) => {
        let timer;
        const finish = () => {
            clearTimeout(timer);
            ctx.signal.removeEventListener('abort', finish);
            resolve();
        };
        timer = setTimeout(finish, ms);
        ctx.signal.addEventListener('abort', finish, { once: true });
    });
    return ctx.signal.aborted ? 130 : 0;
};
export default command;
