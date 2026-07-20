import { findUnixUserName } from '../../../../shell/unix-accounts.js';
const command = async (ctx) => {
    ctx.stdout.write((findUnixUserName(ctx.vfs, ctx.cred.uid) ?? String(ctx.cred.uid)) + '\n');
    return 0;
};
export default command;
