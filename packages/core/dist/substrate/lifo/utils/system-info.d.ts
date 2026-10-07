/**
 * What the system commands (uptime, top, free, fastfetch) and node's `os`
 * report about the machine, read in one place: the JS heap, where the
 * runtime exposes it, and the time since the shell came up.
 */
/** The heap as `performance.memory` reports it, where a runtime has it (Chromium does; workerd and Bun do not). */
export declare function readHeapMemory(): {
    total: number;
    used: number;
} | null;
/**
 * Whole seconds since the first call: the shell's registration makes one as
 * it comes up, so every later reader counts from the same moment.
 */
export declare function uptimeSeconds(): number;
/** `seconds` as procps' uptime and top print it after "up ": `2 days,  3:04`, ` 3:04` or `5 min`. */
export declare function formatUptime(seconds: number): string;
/** `bytes` in binary units, as fastfetch and `free -h` print them: `512 B`, `1.5 KiB`, `2.25 GiB`. */
export declare function formatBinarySize(bytes: number): string;
//# sourceMappingURL=system-info.d.ts.map