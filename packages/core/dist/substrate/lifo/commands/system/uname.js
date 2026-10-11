import { SYSTEM_IDENTITY } from '../../../../constants.js';
/** The system Nimbus presents (core constants.ts SYSTEM_IDENTITY), as GNU uname prints it. */
const INFO = {
    ...SYSTEM_IDENTITY,
    processor: 'unknown',
    platform: 'unknown',
    operatingSystem: 'GNU/Linux',
};
const FIELDS = {
    s: INFO.sysname,
    n: INFO.nodename,
    r: INFO.release,
    v: INFO.version,
    m: INFO.machine,
    p: INFO.processor,
    i: INFO.platform,
    o: INFO.operatingSystem,
};
const ALL_ORDER = ['s', 'n', 'r', 'v', 'm', 'o'];
const command = async (ctx) => {
    const selected = new Set();
    for (const arg of ctx.args) {
        if (!arg.startsWith('-'))
            continue;
        if (arg === '--all') {
            for (const flag of ALL_ORDER)
                selected.add(flag);
            continue;
        }
        for (let i = 1; i < arg.length; i++) {
            if (arg[i] === 'a')
                for (const flag of ALL_ORDER)
                    selected.add(flag);
            else if (arg[i] in FIELDS)
                selected.add(arg[i]);
        }
    }
    if (selected.size === 0) {
        await ctx.stdout.write(INFO.sysname + '\n');
        return 0;
    }
    const order = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].filter((f) => selected.has(f));
    await ctx.stdout.write(order.map((f) => FIELDS[f]).join(' ') + '\n');
    return 0;
};
export default command;
