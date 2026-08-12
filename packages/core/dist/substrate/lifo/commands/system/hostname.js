const command = async (ctx) => {
    const hostname = ctx.env.HOSTNAME || 'lifo';
    ctx.stdout.write(hostname + '\n');
    return 0;
};
export default command;
