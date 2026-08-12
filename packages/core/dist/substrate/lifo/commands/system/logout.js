export function createLogoutCommand(deleteToken, onExit) {
    return async (ctx) => {
        try {
            deleteToken();
            ctx.env.LIFO_TOKEN = '';
            ctx.stdout.write('Logged out.\n');
            onExit();
        }
        catch {
            ctx.stdout.write('Not logged in.\n');
        }
        return 0;
    };
}
export default createLogoutCommand(() => { }, () => { });
