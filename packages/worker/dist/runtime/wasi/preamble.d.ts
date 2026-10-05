import type { FdEntry, WasiInitOptions, WasiInstanceBundle, WasiMakeImportsOptions, WasiRunResult, WasiStartInstance, WasiSupervisorStub } from '@nimbus-sh/core/runtime/wasi/types.js';
import { type ResidentFilesystemStats } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
/** This process's filesystem calls so far and who answered them (ResidentFilesystemStats), or null when the session answered them all. */
export declare function __wasiFsStats(): ResidentFilesystemStats | null;
export declare function __wasiAdoptSupervisor(sup: WasiSupervisorStub | null): void;
export declare function __wasiInitFS(opts: WasiInitOptions): void;
export declare const fdTable: Map<number, FdEntry>;
export declare function __wasiMakeImports(opts: WasiMakeImportsOptions): WasiInstanceBundle;
export declare function __wasiRunStart(instance: WasiStartInstance, ctx?: unknown): WasiRunResult;
export declare function __wasiRunStartAsync(instance: WasiStartInstance, ctx?: unknown): Promise<WasiRunResult>;
//# sourceMappingURL=preamble.d.ts.map