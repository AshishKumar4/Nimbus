const USAGE = `Usage: systemctl <command> [unit]

Commands:
  start <unit>       Start a service
  stop <unit>        Stop a service
  restart <unit>     Restart a service
  status <unit>      Show service status
  enable <unit>      Enable service at boot
  disable <unit>     Disable service at boot
  list-units         List all known units
  daemon-reload      Reload unit file definitions
`;
export function createSystemctlCommand(kernal) {
    const serviceManager = kernal.serviceManager;
    return async (ctx) => {
        const subcommand = ctx.args[0];
        const unit = ctx.args[1];
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
            await ctx.stdout.write(USAGE);
            return 0;
        }
        switch (subcommand) {
            case 'start': {
                if (!unit) {
                    await ctx.stderr.write('systemctl start: missing unit name\n');
                    return 1;
                }
                const result = await serviceManager.start(unit);
                if (!result.ok) {
                    await ctx.stderr.write(`Failed to start ${unit}: ${result.message}\n`);
                    return 1;
                }
                return 0;
            }
            case 'stop': {
                if (!unit) {
                    await ctx.stderr.write('systemctl stop: missing unit name\n');
                    return 1;
                }
                const result = await serviceManager.stop(unit);
                if (!result.ok) {
                    await ctx.stderr.write(`Failed to stop ${unit}: ${result.message}\n`);
                    return 1;
                }
                return 0;
            }
            case 'restart': {
                if (!unit) {
                    await ctx.stderr.write('systemctl restart: missing unit name\n');
                    return 1;
                }
                const result = await serviceManager.restart(unit);
                if (!result.ok) {
                    await ctx.stderr.write(`Failed to restart ${unit}: ${result.message}\n`);
                    return 1;
                }
                return 0;
            }
            case 'status': {
                if (!unit) {
                    await ctx.stderr.write('systemctl status: missing unit name\n');
                    return 1;
                }
                const info = serviceManager.status(unit);
                const dot = info.active === 'active'
                    ? '\x1b[32m●\x1b[0m'
                    : info.active === 'failed'
                        ? '\x1b[31m●\x1b[0m'
                        : '\x1b[90m●\x1b[0m';
                await ctx.stdout.write(`${dot} ${info.name}.service - ${info.description || 'No description'}\n`);
                if (info.loaded) {
                    await ctx.stdout.write(`     Loaded: loaded (/etc/systemd/system/${info.name}.service; ${info.enabled ? 'enabled' : 'disabled'})\n`);
                }
                else {
                    await ctx.stdout.write(`     Loaded: not-found\n`);
                }
                await ctx.stdout.write(`     Active: ${info.active} (${info.sub})`);
                if (info.startedAt) {
                    const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
                    await ctx.stdout.write(` since ${formatElapsed(elapsed)} ago`);
                }
                await ctx.stdout.write('\n');
                if (info.pid !== null) {
                    await ctx.stdout.write(`   Main PID: ${info.pid}\n`);
                }
                if (info.exitCode !== null && info.exitCode !== 0) {
                    await ctx.stdout.write(`   Exit code: ${info.exitCode}\n`);
                }
                return 0;
            }
            case 'enable': {
                if (!unit) {
                    await ctx.stderr.write('systemctl enable: missing unit name\n');
                    return 1;
                }
                const result = serviceManager.enable(unit);
                if (!result.ok) {
                    await ctx.stderr.write(`Failed to enable ${unit}: ${result.message}\n`);
                    return 1;
                }
                if (result.message)
                    await ctx.stdout.write(result.message + '\n');
                return 0;
            }
            case 'disable': {
                if (!unit) {
                    await ctx.stderr.write('systemctl disable: missing unit name\n');
                    return 1;
                }
                const result = serviceManager.disable(unit);
                if (!result.ok) {
                    await ctx.stderr.write(`Failed to disable ${unit}: ${result.message}\n`);
                    return 1;
                }
                if (result.message)
                    await ctx.stdout.write(result.message + '\n');
                return 0;
            }
            case 'list-units': {
                const units = serviceManager.listUnits();
                if (units.length === 0) {
                    await ctx.stdout.write('No units found.\n');
                    return 0;
                }
                // Table header
                await ctx.stdout.write('UNIT'.padEnd(24) +
                    'LOAD'.padEnd(10) +
                    'ACTIVE'.padEnd(12) +
                    'SUB'.padEnd(14) +
                    'DESCRIPTION\n');
                for (const u of units) {
                    const dot = u.active === 'active'
                        ? '\x1b[32m●\x1b[0m'
                        : u.active === 'failed'
                            ? '\x1b[31m●\x1b[0m'
                            : '\x1b[90m●\x1b[0m';
                    await ctx.stdout.write(`${dot} ${(u.name + '.service').padEnd(22)}` +
                        (u.loaded ? 'loaded' : 'not-found').padEnd(10) +
                        u.active.padEnd(12) +
                        u.sub.padEnd(14) +
                        (u.description || '') + '\n');
                }
                await ctx.stdout.write(`\n${units.length} unit(s) listed.\n`);
                return 0;
            }
            case 'daemon-reload': {
                serviceManager.daemonReload();
                return 0;
            }
            default:
                await ctx.stderr.write(`Unknown command '${subcommand}'. See 'systemctl --help'.\n`);
                return 1;
        }
    };
}
function formatElapsed(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}min`;
}
