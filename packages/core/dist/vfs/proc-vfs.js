import { syscallError } from './vfs-error.js';
const enc = new TextEncoder();
const DIR = { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40555, uid: 0, gid: 0 };
function key(path) {
    return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}
export class ProcVFS {
    cred;
    files;
    sync;
    constructor(files, cred = null) {
        this.cred = cred;
        this.files = files ?? new Map();
        this.sync = this;
    }
    /** Add or replace `/proc/<name>`. */
    register(name, generator) {
        this.files.set(key(name), generator);
    }
    /** The same files, generated for `cred`. */
    as(cred) {
        return new ProcVFS(this.files, cred);
    }
    isDir(k) {
        if (k === '')
            return true;
        for (const name of this.files.keys())
            if (name.startsWith(`${k}/`))
                return true;
        return false;
    }
    generate(path) {
        const k = key(path);
        const generator = this.files.get(k);
        if (generator === undefined)
            throw syscallError(this.isDir(k) ? 'EISDIR' : 'ENOENT', 'open', path);
        return enc.encode(generator(this.cred));
    }
    stat(path) {
        const k = key(path);
        if (this.isDir(k))
            return DIR;
        if (!this.files.has(k))
            return null;
        return { type: 'file', size: this.generate(path).length, mtimeMs: Date.now(), mode: 0o100444, uid: 0, gid: 0 };
    }
    readFile(path) {
        return this.generate(path);
    }
    readRange(path, offset, length) {
        return this.generate(path).slice(offset, offset + length);
    }
    readdir(path) {
        const k = key(path);
        if (!this.isDir(k))
            throw syscallError(this.files.has(k) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
        const prefix = k === '' ? '' : `${k}/`;
        const out = new Map();
        for (const name of this.files.keys()) {
            if (!name.startsWith(prefix))
                continue;
            const rest = name.slice(prefix.length);
            const slash = rest.indexOf('/');
            const child = slash < 0 ? rest : rest.slice(0, slash);
            if (!out.has(child))
                out.set(child, { name: child, type: slash < 0 ? 'file' : 'directory' });
        }
        return [...out.values()];
    }
    readOnly(syscall, path) {
        throw syscallError('EROFS', syscall, path, { detail: '/proc is read-only' });
    }
    writeFile(path) { this.readOnly('open', path); }
    mkdir(path) { this.readOnly('mkdir', path); }
    unlink(path) { this.readOnly('unlink', path); }
    rmdir(path) { this.readOnly('rmdir', path); }
    describe() {
        return { source: 'proc', type: 'proc', options: ['ro'] };
    }
}
/**
 * The /proc every workspace has: cpuinfo, meminfo, uptime, version and
 * net/info. ProcessFiles adds `mounts`, and a host adds its own with
 * `register`.
 */
export function standardProc() {
    const proc = new ProcVFS();
    proc.register('cpuinfo', () => {
        const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1;
        const lines = [];
        for (let i = 0; i < cores; i++) {
            lines.push(`processor\t: ${i}`, 'model name\t: Browser Virtual CPU', `cpu cores\t: ${cores}`, '');
        }
        return lines.join('\n');
    });
    proc.register('meminfo', () => {
        const memory = globalThis.performance?.memory;
        if (!memory)
            return ['MemTotal:       2097152 kB', 'MemFree:        1048576 kB', 'MemUsed:        1048576 kB', ''].join('\n');
        const totalKB = Math.floor(memory.jsHeapSizeLimit / 1024);
        const usedKB = Math.floor(memory.usedJSHeapSize / 1024);
        return [
            `MemTotal:       ${totalKB} kB`,
            `MemFree:        ${totalKB - usedKB} kB`,
            `MemUsed:        ${usedKB} kB`,
            `HeapTotal:      ${Math.floor(memory.totalJSHeapSize / 1024)} kB`,
            '',
        ].join('\n');
    });
    proc.register('uptime', () => {
        const seconds = typeof performance !== 'undefined' ? (performance.now() / 1000).toFixed(2) : '0.00';
        return `${seconds} ${seconds}\n`;
    });
    proc.register('version', () => `Lifo 1.0.0 (${typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js'})\n`);
    proc.register('net/info', () => {
        const conn = typeof navigator !== 'undefined'
            ? navigator.connection
            : undefined;
        if (!conn)
            return 'Network information not available\n';
        return [
            `type:          ${conn.type ?? 'unknown'}`,
            `effectiveType: ${conn.effectiveType ?? 'unknown'}`,
            `downlink:      ${conn.downlink ?? 0} Mbps`,
            `rtt:           ${conn.rtt ?? 0} ms`,
            '',
        ].join('\n');
    });
    return proc;
}
