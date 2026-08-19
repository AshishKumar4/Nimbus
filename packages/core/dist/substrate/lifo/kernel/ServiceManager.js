import { parseUnitFile } from './unit-parser.js';
const UNIT_DIR = '/etc/systemd/system';
const WANTS_DIR = '/etc/systemd/system/multi-user.target.wants';
const LOG_DIR = '/var/log';
let nextPid = 1000;
export class ServiceManager {
    vfs;
    registry;
    defaultEnv;
    services = new Map();
    unitCache = new Map();
    constructor(vfs, registry, defaultEnv) {
        this.vfs = vfs;
        this.registry = registry;
        this.defaultEnv = defaultEnv;
    }
    /** Reload unit files from disk */
    daemonReload() {
        this.unitCache.clear();
    }
    resolveUnit(name) {
        const svcName = name.endsWith('.service') ? name : name + '.service';
        if (this.unitCache.has(svcName)) {
            return this.unitCache.get(svcName);
        }
        const path = UNIT_DIR + '/' + svcName;
        if (!this.vfs.exists(path))
            return null;
        const content = this.vfs.readFileString(path);
        const unit = parseUnitFile(content);
        this.unitCache.set(svcName, unit);
        return unit;
    }
    baseName(name) {
        return name.endsWith('.service') ? name.slice(0, -8) : name;
    }
    async start(name) {
        const base = this.baseName(name);
        const existing = this.services.get(base);
        if (existing && existing.exitCode === null) {
            return { ok: true, message: '' }; // already running
        }
        const unit = this.resolveUnit(name);
        if (!unit) {
            return { ok: false, message: `Unit ${base}.service not found.` };
        }
        if (!unit.Service.ExecStart) {
            return { ok: false, message: `Unit ${base}.service has no ExecStart.` };
        }
        const pid = nextPid++;
        const abortController = new AbortController();
        const logPath = LOG_DIR + '/' + base + '.log';
        // Build an isolated CommandContext for the service
        const logStream = {
            write: (text) => {
                try {
                    const existing = this.vfs.exists(logPath)
                        ? this.vfs.readFileString(logPath)
                        : '';
                    this.vfs.writeFile(logPath, existing + text);
                }
                catch { /* ignore log failures */ }
            },
        };
        const env = {
            ...this.defaultEnv,
            ...(unit.Service.Environment ?? {}),
        };
        const cwd = unit.Service.WorkingDirectory ?? this.defaultEnv.HOME ?? '/';
        // Parse ExecStart into command name + args
        const parts = unit.Service.ExecStart.split(/\s+/);
        const cmdName = parts[0];
        const cmdArgs = parts.slice(1);
        const cmd = await this.registry.resolve(cmdName);
        if (!cmd) {
            return { ok: false, message: `Command '${cmdName}' not found for ExecStart.` };
        }
        const ctx = {
            pid,
            cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
            args: cmdArgs,
            env,
            cwd,
            vfs: this.vfs,
            stdout: logStream,
            stderr: logStream,
            signal: abortController.signal,
            setUmask: () => { },
            runAs: async () => 126,
        };
        const promise = cmd(ctx).catch((err) => {
            if (abortController.signal.aborted)
                return -1;
            logStream.write(`Service error: ${err}\n`);
            return 1;
        });
        const svc = {
            name: base,
            unit,
            pid,
            startedAt: Date.now(),
            abortController,
            promise,
            exitCode: null,
            restartTimer: null,
        };
        this.services.set(base, svc);
        // Handle service completion
        promise.then((code) => {
            svc.exitCode = code;
            this.handleServiceExit(svc);
        });
        return { ok: true, message: '' };
    }
    handleServiceExit(svc) {
        const restart = svc.unit.Service.Restart ?? 'no';
        const shouldRestart = restart === 'always' ||
            (restart === 'on-failure' && svc.exitCode !== 0);
        if (shouldRestart && !svc.abortController.signal.aborted) {
            const delaySec = svc.unit.Service.RestartSec ?? 1;
            svc.restartTimer = setTimeout(() => {
                if (!svc.abortController.signal.aborted) {
                    this.start(svc.name);
                }
            }, delaySec * 1000);
        }
    }
    async stop(name) {
        const base = this.baseName(name);
        const svc = this.services.get(base);
        if (!svc) {
            return { ok: false, message: `Unit ${base}.service not loaded.` };
        }
        // Cancel restart timer
        if (svc.restartTimer) {
            clearTimeout(svc.restartTimer);
            svc.restartTimer = null;
        }
        if (svc.exitCode !== null) {
            return { ok: true, message: '' };
        }
        // If there's an ExecStop command, try to run it
        if (svc.unit.Service.ExecStop) {
            const parts = svc.unit.Service.ExecStop.split(/\s+/);
            const cmd = await this.registry.resolve(parts[0]);
            if (cmd) {
                const noop = { write: () => { } };
                try {
                    await cmd({
                        pid: svc.pid,
                        cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
                        args: parts.slice(1),
                        env: { ...this.defaultEnv },
                        cwd: this.defaultEnv.HOME ?? '/',
                        vfs: this.vfs,
                        stdout: noop,
                        stderr: noop,
                        signal: AbortSignal.timeout(5000),
                        setUmask: () => { },
                        runAs: async () => 126,
                    });
                }
                catch { /* ignore */ }
            }
        }
        // Abort the running command
        svc.abortController.abort();
        svc.exitCode = -1;
        return { ok: true, message: '' };
    }
    async restart(name) {
        const base = this.baseName(name);
        const svc = this.services.get(base);
        if (svc && svc.exitCode === null) {
            await this.stop(base);
        }
        return this.start(base);
    }
    status(name) {
        const base = this.baseName(name);
        const svc = this.services.get(base);
        const unit = this.resolveUnit(name);
        const enabled = this.isEnabled(base);
        if (!svc) {
            return {
                name: base,
                description: unit?.Unit.Description ?? '',
                loaded: unit !== null,
                active: 'inactive',
                sub: 'dead',
                enabled,
                pid: null,
                startedAt: null,
                exitCode: null,
            };
        }
        let active;
        let sub;
        if (svc.exitCode === null) {
            active = 'active';
            sub = 'running';
        }
        else if (svc.exitCode === 0) {
            active = 'inactive';
            sub = 'exited';
        }
        else if (svc.abortController.signal.aborted) {
            active = 'inactive';
            sub = 'dead';
        }
        else {
            active = 'failed';
            sub = 'dead';
        }
        // Check if restarting
        if (svc.restartTimer) {
            active = 'activating';
            sub = 'auto-restart';
        }
        return {
            name: base,
            description: unit?.Unit.Description ?? svc.unit.Unit.Description ?? '',
            loaded: true,
            active,
            sub,
            enabled,
            pid: svc.exitCode === null ? svc.pid : null,
            startedAt: svc.startedAt,
            exitCode: svc.exitCode,
        };
    }
    enable(name) {
        const base = this.baseName(name);
        const unit = this.resolveUnit(name);
        if (!unit) {
            return { ok: false, message: `Unit ${base}.service not found.` };
        }
        const linkPath = WANTS_DIR + '/' + base + '.service';
        try {
            this.vfs.writeFile(linkPath, '');
        }
        catch {
            return { ok: false, message: `Failed to enable ${base}.service.` };
        }
        return { ok: true, message: `Created symlink ${linkPath}.` };
    }
    disable(name) {
        const base = this.baseName(name);
        const linkPath = WANTS_DIR + '/' + base + '.service';
        if (!this.vfs.exists(linkPath)) {
            return { ok: true, message: '' };
        }
        try {
            this.vfs.unlink(linkPath);
        }
        catch {
            return { ok: false, message: `Failed to disable ${base}.service.` };
        }
        return { ok: true, message: `Removed ${linkPath}.` };
    }
    isEnabled(base) {
        return this.vfs.exists(WANTS_DIR + '/' + base + '.service');
    }
    listUnits() {
        const units = [];
        const seen = new Set();
        // Running services
        for (const [base] of this.services) {
            seen.add(base);
            units.push(this.status(base));
        }
        // Unit files on disk
        try {
            const entries = this.vfs.readdir(UNIT_DIR);
            for (const entry of entries) {
                if (entry.type === 'file' && entry.name.endsWith('.service')) {
                    const base = entry.name.slice(0, -8);
                    if (!seen.has(base)) {
                        seen.add(base);
                        units.push(this.status(base));
                    }
                }
            }
        }
        catch { /* UNIT_DIR may not exist */ }
        return units;
    }
    async bootEnabledServices() {
        try {
            const entries = this.vfs.readdir(WANTS_DIR);
            for (const entry of entries) {
                if (entry.type === 'file' && entry.name.endsWith('.service')) {
                    const base = entry.name.slice(0, -8);
                    await this.start(base);
                }
            }
        }
        catch { /* WANTS_DIR may not exist yet */ }
    }
}
