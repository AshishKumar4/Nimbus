import type { FdEntry, WasiInitOptions, WasiInstanceBundle, WasiMakeImportsOptions, WasiRunResult, WasiStartInstance, WasiSupervisorStub } from './types.js';
export declare function __wasiAdoptSupervisor(sup: WasiSupervisorStub | null): void;
/**
 * Re-sync the cache with the session VFS. A resident process (a server) must
 * see files that other processes created or changed after it spawned, so the
 * cached content is dropped and metadata re-read on next access.
 */
export declare function __wasiRevalidateFS(): Promise<string[]>;
/**
 * Await every queued mutation. Callers drain before returning a result to the
 * supervisor and before any live read, so the supervisor's view always
 * includes this process's own writes.
 */
export declare function __wasiDrainPersist(): Promise<void>;
export declare function __wasiInitFS(opts: WasiInitOptions): void;
/**
 * Read named files back out as base64.
 *
 * A process with a supervisor has already written everything through as it
 * happened and never calls this. A SEALED one — no supervisor, by design,
 * because it must not be able to reach the session VFS at all — has no other
 * channel, so its caller names the paths it wants and gets exactly those.
 * A path with no file is simply absent from the result.
 */
export declare function __wasiReadFilesB64(paths: string[]): Record<string, string>;
export declare const fdTable: Map<number, FdEntry>;
export declare function __wasiMakeImports(opts: WasiMakeImportsOptions): WasiInstanceBundle;
export declare function __wasiRunStart(instance: WasiStartInstance, ctx?: unknown): WasiRunResult;
export declare function __wasiRunStartAsync(instance: WasiStartInstance, ctx?: unknown): Promise<WasiRunResult>;
//# sourceMappingURL=preamble.d.ts.map