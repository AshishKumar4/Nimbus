export function createLogoutCommand(deleteToken, onExit) {
    return async (ctx) => {
        try {
            deleteToken();
            ctx.env.LIFO_TOKEN = '';
            await ctx.stdout.write('Logged out.\n');
            onExit();
        }
        catch {
            await ctx.stdout.write('Not logged in.\n');
        }
        return 0;
    };
}
export default createLogoutCommand(() => { }, () => { });
