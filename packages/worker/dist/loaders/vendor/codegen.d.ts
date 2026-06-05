import type { WorkerCode } from './types.js';
export interface GenerateSourceOptions {
    /**
     * Key/value pairs injected as module-level `const` declarations,
     * so the function body can reference them as if they were in closure scope.
     * Values must be JSON-serializable.
     */
    context?: Record<string, unknown>;
    /** When true, appends `this.env` as the last argument to the user function. */
    passEnv?: boolean;
}
export declare function generateWorkerSource(fnSource: string, opts?: GenerateSourceOptions): string;
export interface WorkerCodeOptions {
    compatibilityDate?: string;
    compatibilityFlags?: string[];
    env?: Record<string, unknown>;
    /**
     * Network access: `null` (default) = sandboxed, `undefined` = inherit parent,
     * or a service stub to redirect outbound through.
     */
    globalOutbound?: WorkerCode['globalOutbound'];
}
export declare function buildWorkerCode(fnSource: string, opts?: WorkerCodeOptions, sourceOpts?: GenerateSourceOptions): WorkerCode;
//# sourceMappingURL=codegen.d.ts.map