export function createPsCommand(processRegistry) {
    return async (ctx) => {
        await ctx.stdout.write('  PID TTY          TIME CMD\n');
        // Get all processes from registry
        const processes = processRegistry.getAll();
        for (const proc of processes) {
            const info = processRegistry.getFormattedInfo(proc.pid);
            if (info) {
                await ctx.stdout.write(info + '\n');
            }
        }
        return 0;
    };
}
