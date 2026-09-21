import { findUnixUserName } from '../../../../shell/unix-accounts.js';
const command = async (ctx) => {
    await ctx.stdout.write(((await findUnixUserName(ctx.vfs, ctx.cred.uid)) ?? String(ctx.cred.uid)) + '\n');
    return 0;
};
export default command;
