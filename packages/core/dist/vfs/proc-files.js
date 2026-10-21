/** Where the kernel mounts /proc. */
export const PROC_MOUNT_POINT = '/proc';
export const PROC_FILES = {
    cpuinfo: {
        volatile: false,
        generate: () => {
            const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1;
            const lines = [];
            for (let i = 0; i < cores; i++) {
                lines.push(`processor\t: ${i}`, 'model name\t: Browser Virtual CPU', `cpu cores\t: ${cores}`, '');
            }
            return lines.join('\n');
        },
    },
    meminfo: {
        volatile: true,
        generate: () => {
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
        },
    },
    uptime: {
        volatile: true,
        generate: () => {
            const seconds = typeof performance !== 'undefined' ? (performance.now() / 1000).toFixed(2) : '0.00';
            return `${seconds} ${seconds}\n`;
        },
    },
    version: {
        volatile: false,
        generate: () => `Lifo 1.0.0 (${typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js'})\n`,
    },
    'net/info': {
        volatile: true,
        generate: () => {
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
        },
    },
};
/** The generator of /proc/<name> where it is volatile: made by whoever reads it, at each read. */
export function volatileProcFile(name) {
    const file = Object.hasOwn(PROC_FILES, name) ? PROC_FILES[name] : undefined;
    return file?.volatile ? file.generate : undefined;
}
