/**
 * basename NAME [SUFFIX], as GNU's: the name is not normalized (`a/..` is
 * `..`), a name of slashes alone is `/`, and a SUFFIX that is the whole
 * name stays.
 */
const command = async (ctx) => {
    if (ctx.args.length === 0) {
        await ctx.stderr.write('basename: missing operand\n');
        return 1;
    }
    const [name, suffix] = ctx.args;
    const trimmed = name.replace(/\/+$/, '');
    const base = trimmed === '' && name !== '' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
    const stripped = suffix && base !== suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
    await ctx.stdout.write(`${stripped}\n`);
    return 0;
};
export default command;
