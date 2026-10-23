/**
 * The reading isolate's navigator, where it has one. A Worker's says one CPU
 * and Cloudflare-Workers; a process's facet has none, and answers the same
 * as a Worker's, so its /proc is the session's.
 */
const host = () => globalThis.navigator;
/** Where the kernel mounts /proc. */
export const PROC_MOUNT_POINT = '/proc';
export const PROC_FILES = {
    cpuinfo: {
        generate: () => {
            const cores = host()?.hardwareConcurrency ?? 1;
            const lines = [];
            for (let i = 0; i < cores; i++) {
                lines.push(`processor\t: ${i}`, 'model name\t: Browser Virtual CPU', `cpu cores\t: ${cores}`, '');
            }
            return lines.join('\n');
        },
    },
    meminfo: {
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
        generate: () => {
            const seconds = typeof performance !== 'undefined' ? (performance.now() / 1000).toFixed(2) : '0.00';
            return `${seconds} ${seconds}\n`;
        },
    },
    version: {
        generate: () => `Lifo 1.0.0 (${host()?.userAgent ?? 'Cloudflare-Workers'})\n`,
    },
    'net/info': {
        generate: () => {
            const conn = host()?.connection;
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
/** The generator of /proc/<name>, made by whoever reads it, at each read; undefined for a file only the session makes (/proc/mounts, the trust store). */
export function procFileGenerator(name) {
    return Object.hasOwn(PROC_FILES, name) ? PROC_FILES[name].generate : undefined;
}
