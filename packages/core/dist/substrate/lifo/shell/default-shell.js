export function defaultShellPath(home) {
    const normalizedHome = (home || '/home/user').replace(/\/+$/, '');
    return `${normalizedHome}/.config/nimbus/shell`;
}
export async function readDefaultShell(vfs, home) {
    try {
        return (await vfs.readFileString(defaultShellPath(home))).trim() === 'bash' ? 'bash' : 'lifo';
    }
    catch {
        return 'lifo';
    }
}
async function writeDefaultShell(vfs, home, shell) {
    const path = defaultShellPath(home);
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!(await vfs.exists(parent)))
        (await vfs.mkdir(parent, { recursive: true }));
    (await vfs.writeFile(path, `${shell}\n`));
}
export function makeChshCommand(deps) {
    return async (ctx) => {
        const home = ctx.env.HOME || '/home/user';
        if (ctx.args.length === 0) {
            (await ctx.stdout.write(`${(await readDefaultShell(ctx.vfs, home))}\n`));
            return 0;
        }
        if (ctx.args.length !== 2 || ctx.args[0] !== '-s') {
            (await ctx.stderr.write('usage: chsh [-s bash|lifo|sh]\n'));
            return 2;
        }
        const requested = ctx.args[1];
        const shell = requested === 'bash' ? 'bash' :
            requested === 'lifo' || requested === 'sh' ? 'lifo' :
                null;
        if (shell === null) {
            (await ctx.stderr.write(`chsh: unsupported shell '${requested}' (expected bash, lifo, or sh)\n`));
            return 2;
        }
        if (shell === 'bash' && !await deps.isBashInstalled(home)) {
            (await ctx.stderr.write("chsh: bash is not installed (run 'nimbus install bash')\n"));
            return 1;
        }
        try {
            (await writeDefaultShell(ctx.vfs, home, shell));
            (await ctx.stdout.write(`default shell: ${shell}\n`));
            return 0;
        }
        catch (error) {
            (await ctx.stderr.write(`chsh: ${error instanceof Error ? error.message : String(error)}\n`));
            return 1;
        }
    };
}
