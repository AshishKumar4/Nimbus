/**
 * nimbus-command.ts — the `nimbus` shell verb, runtime policy in core.
 *
 *   nimbus install <name>[@<version>]     install via the workspace's manager
 *   nimbus install --list | --available   installed tree / catalog
 *   nimbus install --reinstall <name>     force a rewrite
 *   nimbus uninstall <name>               remove an installed runtime
 *   nimbus expose|app|start …             host application verbs, when supplied
 *
 * Everything network- or session-shaped is injected: installs go through the
 * workspace's RuntimeManager (whose RuntimeSource decides where bytes come
 * from), and `expose`/`app` are the host's own application operations — a
 * library workspace has no session, so the verbs report that instead of
 * pretending.
 */
import { parseRuntimeManifest } from './runtime-manifest.js';
const NIMBUS_USAGE = [
    'usage: nimbus install <name>[@<version>] | nimbus install --list | nimbus install --available | nimbus uninstall <name>',
    '       nimbus expose <port|pid> [--public] [--name <name>]',
    '       nimbus app list | url <name|port> | rotate <name|port> | remove <name|port>',
    '       nimbus start [--restart never|on-failure] <command> [args...]',
].join('\n');
/** The shell-command handler registered under the name `nimbus`. */
export function makeNimbusVerbHandler(deps) {
    return async function nimbus(ctx) {
        const argv = ctx.args || [];
        const verb = argv[0];
        const rest = argv.slice(1);
        if (verb === 'install')
            return runNimbusInstall(rest, ctx, deps);
        if (verb === 'uninstall')
            return runNimbusUninstall(rest, ctx, deps);
        if (verb === 'expose' || verb === 'app' || verb === 'start') {
            if (verb === 'start')
                return runNimbusStart(rest, ctx, deps.registry);
            if (!deps.apps) {
                ctx.stderr.write(`nimbus ${verb}: this host has no session to address applications on\n`);
                return 1;
            }
            try {
                return verb === 'expose' ? await runExpose(rest, ctx, deps.apps) : await runApp(rest, ctx, deps.apps);
            }
            catch (e) {
                ctx.stderr.write(`nimbus ${verb}: ${e instanceof Error ? e.message : String(e)}\n`);
                return 1;
            }
        }
        ctx.stderr.write(`nimbus: unknown subcommand '${verb || '(none)'}'\n`);
        ctx.stderr.write(`${NIMBUS_USAGE}\n`);
        return 2;
    };
}
async function warmInstalledRuntime(seeded, ctx, deps) {
    if (!deps.warmRuntime)
        return;
    let manifest;
    try {
        manifest = parseRuntimeManifest(JSON.parse(deps.vfs.readFileString(`${seeded.root}/manifest.json`)));
    }
    catch {
        return;
    }
    try {
        await deps.warmRuntime({ ...seeded, manifest }, ctx);
    }
    catch (e) {
        ctx.stderr.write(`[${seeded.name}] warning: runtime warm-up failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
}
/** `nimbus install …` as a function so a programmatic caller can run the same
 *  path with a captured ctx instead of going through a shell. */
export async function runNimbusInstall(args, ctx, deps) {
    const listOnly = args.includes('--list');
    const availOnly = args.includes('--available');
    const force = args.includes('--reinstall') || args.includes('--force');
    const positional = args.filter((a) => !a.startsWith('--'));
    if (listOnly) {
        const installed = deps.runtimes.list();
        if (installed.length === 0) {
            ctx.stdout.write('(no runtimes installed)\n');
            return 0;
        }
        ctx.stdout.write(`installed runtimes (${installed.length}):\n`);
        for (const runtime of installed) {
            ctx.stdout.write(`  ${runtime.name}@${runtime.version}  abi=${runtime.abi}  `
                + `${(runtime.sizeBytes / 1024 / 1024).toFixed(1)} MiB  bins=[${runtime.bins.join(', ')}]  ${runtime.root}\n`);
        }
        return 0;
    }
    if (availOnly) {
        let available;
        try {
            available = await deps.runtimes.available();
        }
        catch (e) {
            ctx.stderr.write(`nimbus install --available: ${e instanceof Error ? e.message : String(e)}\n`);
            return 1;
        }
        if (available.length === 0) {
            ctx.stdout.write('(no runtimes in catalog)\n');
            return 0;
        }
        const sorted = [...available].sort((a, b) => a.name.localeCompare(b.name));
        ctx.stdout.write(`available runtimes (${sorted.length}):\n`);
        for (const runtime of sorted) {
            const versions = runtime.versions.map((v) => v.version);
            ctx.stdout.write(`  ${runtime.name}  abi=${runtime.abi}  default=${runtime.defaultVersion}  versions=[${versions.join(', ')}]\n`);
            for (const v of runtime.versions) {
                ctx.stdout.write(`    ${v.version}  ${(v.sizeBytes / 1024 / 1024).toFixed(1)} MiB  license=${v.license}\n`);
            }
        }
        return 0;
    }
    if (positional.length === 0) {
        ctx.stderr.write('nimbus install: missing runtime name\n');
        ctx.stderr.write('usage: nimbus install <name>[@<version>]\n');
        return 2;
    }
    const spec = positional[0];
    try {
        const seeded = await deps.runtimes.install(spec, {
            force,
            onProgress: (line) => ctx.stdout.write(`${line}\n`),
        });
        await warmInstalledRuntime(seeded, ctx, deps);
        return 0;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.stderr.write(`nimbus install: ${message}\n`);
        if (message.endsWith('is not in catalog')) {
            ctx.stderr.write(`nimbus install: try 'nimbus install --available' to see installable runtimes\n`);
        }
        return 1;
    }
}
async function runNimbusUninstall(args, ctx, deps) {
    if (args.length === 0 || args[0].startsWith('--')) {
        ctx.stderr.write('nimbus uninstall: missing runtime name\n');
        return 2;
    }
    const spec = args[0];
    const atIdx = spec.indexOf('@');
    const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
    const version = atIdx >= 0 ? spec.slice(atIdx + 1) : null;
    const matches = deps.runtimes.list().filter((runtime) => runtime.name === name && (version === null || runtime.version === version));
    if (matches.length === 0) {
        ctx.stderr.write(`nimbus uninstall: '${name}' is not installed\n`);
        return 1;
    }
    await deps.runtimes.uninstall(spec);
    for (const match of matches) {
        ctx.stdout.write(`[${match.name}@${match.version}] uninstalled (removed ${match.root})\n`);
    }
    return 0;
}
// ── expose / app / start ─────────────────────────────────────────────
/** `<port|pid|name>` as the verbs take it: digits are a port or pid, anything else a name. */
function appTargetArg(raw) {
    return /^\d+$/.test(raw) ? Number(raw) : raw;
}
async function runExpose(args, ctx, apps) {
    let target;
    let name;
    let visibility;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--public')
            visibility = 'public';
        else if (arg === '--scoped')
            visibility = 'scoped';
        else if (arg === '--name') {
            name = args[++i];
        }
        else if (arg.startsWith('--name='))
            name = arg.slice('--name='.length);
        else if (arg.startsWith('--')) {
            ctx.stderr.write(`nimbus expose: unknown flag ${arg}\n`);
            return 2;
        }
        else if (target === undefined)
            target = arg;
        else {
            ctx.stderr.write('nimbus expose: one target only\n');
            return 2;
        }
    }
    if (target === undefined) {
        ctx.stderr.write('usage: nimbus expose <port|pid> [--public] [--name <name>]\n');
        return 2;
    }
    const exposed = await apps.expose(appTargetArg(target), {
        ...(visibility !== undefined ? { visibility } : {}),
        ...(name !== undefined ? { name } : {}),
    });
    ctx.stdout.write(`${exposed.url ?? `(no URL: port ${exposed.port}, capability ${exposed.capability ?? 'none'})`}\n`);
    ctx.stdout.write(`  ${exposed.visibility} · ${exposed.name ?? exposed.owner} · port ${exposed.port}\n`);
    return 0;
}
async function runApp(args, ctx, apps) {
    const [sub, target] = args;
    if (sub === 'list' || sub === 'ls') {
        const rows = await apps.list();
        if (rows.length === 0) {
            ctx.stdout.write('(no applications)\n');
            return 0;
        }
        for (const app of rows) {
            const label = app.name ?? app.owner;
            const where = app.port === null ? '-' : String(app.port);
            const pid = app.pid === null ? '-' : String(app.pid);
            const status = app.diagnostic ? `${app.status} (${app.diagnostic})` : app.status;
            ctx.stdout.write(`${label}\t${where}\t${pid}\t${status}\t${app.visibility}\t${app.restart}\t${app.url ?? '-'}\n`);
        }
        return 0;
    }
    if (target === undefined || (sub !== 'url' && sub !== 'rotate' && sub !== 'remove')) {
        ctx.stderr.write('usage: nimbus app list | url <name|port> | rotate <name|port> | remove <name|port>\n');
        return 2;
    }
    const t = appTargetArg(target);
    if (sub === 'url') {
        const app = (await apps.list()).find((row) => row.name === t || row.owner === t || row.port === t || row.pid === t);
        if (!app) {
            ctx.stderr.write(`nimbus app url: no application matches ${target}\n`);
            return 1;
        }
        ctx.stdout.write(`${app.url ?? `(no URL: port ${app.port ?? '-'})`}\n`);
        return 0;
    }
    if (sub === 'rotate') {
        const rotated = await apps.rotateLink(t);
        ctx.stdout.write(`${rotated.url ?? `(no URL: port ${rotated.port}, capability ${rotated.capability ?? 'none'})`}\n`);
        return 0;
    }
    const removed = await apps.remove(t);
    ctx.stdout.write(removed.removed
        ? `removed ${removed.owner}${removed.port !== null ? ` (port ${removed.port} released)` : ''}\n`
        : `nothing to remove for ${removed.owner}\n`);
    return removed.removed ? 0 : 1;
}
/**
 * `nimbus start [--restart <policy>] <command> [args...]` — run a registered
 * command with the restart policy in its environment, which is where the
 * resident it starts reads the policy from (`NIMBUS_RESTART`), exactly as the
 * SDK's `startProcess({ restart })` carries it.
 */
async function runNimbusStart(args, ctx, registry) {
    let restart = 'never';
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--restart') {
            const policy = args[++i];
            if (policy !== 'never' && policy !== 'on-failure') {
                ctx.stderr.write(`nimbus start: --restart must be never or on-failure, got ${policy ?? '(none)'}\n`);
                return 2;
            }
            restart = policy;
        }
        else if (arg.startsWith('--restart=')) {
            const policy = arg.slice('--restart='.length);
            if (policy !== 'never' && policy !== 'on-failure') {
                ctx.stderr.write(`nimbus start: --restart must be never or on-failure, got ${policy}\n`);
                return 2;
            }
            restart = policy;
        }
        else if (arg === '--') {
            i += 1;
            break;
        }
        else if (arg.startsWith('--')) {
            ctx.stderr.write(`nimbus start: unknown flag ${arg}\n`);
            return 2;
        }
        else
            break;
    }
    const [command, ...commandArgs] = args.slice(i);
    if (!command) {
        ctx.stderr.write('usage: nimbus start [--restart never|on-failure] <command> [args...]\n');
        return 2;
    }
    const handler = registry.resolve ? await registry.resolve(command) : null;
    if (!handler) {
        ctx.stderr.write(`nimbus start: ${command}: command not found\n`);
        return 127;
    }
    return handler({
        ...ctx,
        args: commandArgs,
        env: { ...ctx.env, NIMBUS_RESTART: restart },
    });
}
