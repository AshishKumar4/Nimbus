import { formatBinarySize, readHeapMemory } from '../../utils/system-info.js';
const command = async (ctx) => {
    const human = ctx.args.includes('-h');
    const memory = readHeapMemory();
    if (memory === null) {
        await ctx.stdout.write('Memory information not available in this runtime\n');
        return 0;
    }
    const cell = (bytes) => (human ? formatBinarySize(bytes) : String(bytes)).padStart(10);
    await ctx.stdout.write('              total        used        free\n');
    await ctx.stdout.write(`Mem:     ${cell(memory.total)}  ${cell(memory.used)}  ${cell(memory.total - memory.used)}\n`);
    return 0;
};
export default command;
