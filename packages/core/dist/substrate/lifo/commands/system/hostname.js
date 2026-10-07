import { DEFAULT_HOSTNAME } from '../../../../constants.js';
/** The host's name, as uname's nodename: not $HOSTNAME, which a user may set to anything. */
const command = async (ctx) => {
    await ctx.stdout.write(`${DEFAULT_HOSTNAME}\n`);
    return 0;
};
export default command;
