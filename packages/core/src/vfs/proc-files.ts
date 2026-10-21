/**
 * The /proc every workspace has, but its trust store: each file's generator
 * and whether it is volatile (made at each read: the heap, the clock, the
 * network). One source for the session's /proc (proc-vfs.ts standardProc)
 * and for a process's resident filesystem, which makes a volatile file
 * itself at each read rather than ask the session for bytes that are stale
 * once they arrive.
 */
import type { VfsCred } from './vfs.js';

/**
 * A /proc file's content, for the credential of the process reading it (null:
 * the embedder's view): text made when read, or bytes made once and shared,
 * which a whole-file read copies and a stat or ranged read does not.
 */
export type ProcGenerator = (cred: VfsCred | null) => string | Uint8Array;

/** Where the kernel mounts /proc. */
export const PROC_MOUNT_POINT = '/proc';

export const PROC_FILES: Readonly<Record<string, { readonly generate: ProcGenerator; readonly volatile: boolean }>> = {
  cpuinfo: {
    volatile: false,
    generate: () => {
      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1;
      const lines: string[] = [];
      for (let i = 0; i < cores; i++) {
        lines.push(`processor\t: ${i}`, 'model name\t: Browser Virtual CPU', `cpu cores\t: ${cores}`, '');
      }
      return lines.join('\n');
    },
  },
  meminfo: {
    volatile: true,
    generate: () => {
      const memory = ((globalThis as { performance?: unknown }).performance as {
        memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number; totalJSHeapSize: number };
      } | undefined)?.memory;
      if (!memory) return ['MemTotal:       2097152 kB', 'MemFree:        1048576 kB', 'MemUsed:        1048576 kB', ''].join('\n');
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
        ? (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number; type?: string } }).connection
        : undefined;
      if (!conn) return 'Network information not available\n';
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
export function volatileProcFile(name: string): ProcGenerator | undefined {
  const file = Object.hasOwn(PROC_FILES, name) ? PROC_FILES[name] : undefined;
  return file?.volatile ? file.generate : undefined;
}
