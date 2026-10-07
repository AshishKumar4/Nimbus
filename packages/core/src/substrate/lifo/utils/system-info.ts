/**
 * What the system commands (uptime, top, free, fastfetch) and node's `os`
 * report about the machine, read in one place: the JS heap, where the
 * runtime exposes it, and the time since the shell came up.
 */

/** The heap as `performance.memory` reports it, where a runtime has it (Chromium does; workerd and Bun do not). */
export function readHeapMemory(): { total: number; used: number } | null {
  if (typeof performance === 'undefined' || !('memory' in performance)) return null;
  const memory: unknown = performance.memory;
  if (typeof memory !== 'object' || memory === null || !('jsHeapSizeLimit' in memory) || !('usedJSHeapSize' in memory)) return null;
  const { jsHeapSizeLimit: total, usedJSHeapSize: used } = memory;
  return typeof total === 'number' && typeof used === 'number' ? { total, used } : null;
}

let bootedAt: number | null = null;

/**
 * Whole seconds since the first call: the shell's registration makes one as
 * it comes up, so every later reader counts from the same moment.
 */
export function uptimeSeconds(): number {
  bootedAt ??= Date.now();
  return Math.floor((Date.now() - bootedAt) / 1000);
}

/** `seconds` as procps' uptime and top print it after "up ": `2 days,  3:04`, ` 3:04` or `5 min`. */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const clock = hours > 0 ? `${String(hours).padStart(2)}:${String(minutes).padStart(2, '0')}` : `${minutes} min`;
  return days > 0 ? `${days} day${days === 1 ? '' : 's'}, ${clock}` : clock;
}

/** `bytes` in binary units, as fastfetch and `free -h` print them: `512 B`, `1.5 KiB`, `2.25 GiB`. */
export function formatBinarySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
