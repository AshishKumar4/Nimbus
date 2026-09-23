import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { ProcessLogReadOptions } from '@nimbus-sh/core/runtime/process-logs.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SandboxFs } from '@nimbus-sh/core/substrate/lifo/sandbox/types.js';
import { type SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { ComposedFacetManager, FacetManagerHostHooks } from '../facets/compose.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import * as operations from '../session/programmatic.js';
import * as services from './services.js';
import { z } from 'zod/v4';
declare const HostedTask: z.ZodEnum<{
    "resident-launch": "resident-launch";
    "log-flush": "log-flush";
    "log-janitor": "log-janitor";
}>;
export type HostedRuntimeTask = z.infer<typeof HostedTask>;
export interface HostedRuntimeLifecycle {
    waitUntil(task: Promise<void>): void;
    schedule(reason: HostedRuntimeTask, at: number): Promise<void>;
    cancel(reason: HostedRuntimeTask): Promise<void>;
}
export interface HostedRuntimeOptions {
    workspace: NimbusWorkspace;
    ctx: DurableObjectState;
    env: services.HostedRuntimeEnv;
    ports: PortRegistry;
    lifecycle: HostedRuntimeLifecycle;
    resolveWorkerLaunch?: FacetManagerHostHooks['resolveWorkerLaunch'];
    basePath?: string;
    origin?: string;
}
export interface RuntimeFiles extends SandboxFs {
    as(cred: VfsCred): RuntimeFiles;
}
export declare function composeHostedRuntime(options: HostedRuntimeOptions): Promise<{
    workspace: NimbusWorkspace;
    terminal: WebSocketTerminal;
    files: RuntimeFiles;
    runtimes: import("@nimbus-sh/core/runtime/runtime-manager.js").RuntimeManager;
    facets: () => ComposedFacetManager;
    ready: (options?: operations.ProgrammaticReadyOptions | undefined) => Promise<{
        ok: true;
        preinstalled: string[];
    }>;
    exec: (command: string, options?: operations.ProgrammaticExecOptions | undefined) => Promise<import("@nimbus-sh/core/runtime/exec-stream.js").ExecOutput>;
    execStream: (command: string, options?: operations.ProgrammaticExecOptions | undefined) => Promise<import("@nimbus-sh/core/runtime/exec-stream.js").ExecStream>;
    runCode: (code: string, options?: (operations.ProgrammaticExecOptions & {
        language?: "javascript" | "typescript" | "python" | "ruby" | "shell";
        install?: "never" | "ifMissing";
    }) | undefined) => Promise<import("@nimbus-sh/core/runtime/exec-stream.js").ExecOutput>;
    startProcess: (command: string, options?: operations.ProgrammaticExecOptions | undefined) => Promise<operations.ProgrammaticStartResult>;
    listProcesses: () => Promise<operations.SerializedProcess[]>;
    killProcess: (pid: number) => Promise<{
        ok: boolean;
        pid: number;
    }>;
    writeProcessInput: (pid: number, data: string) => Promise<{
        ok: boolean;
        pid: number;
    }>;
    endProcessInput: (pid: number) => Promise<{
        ok: boolean;
        pid: number;
    }>;
    resizeProcess: (pid: number, size: {
        columns: number;
        rows: number;
    }) => Promise<{
        ok: boolean;
        pid: number;
    }>;
    signalProcess: (pid: number, signal: string) => Promise<{
        ok: boolean;
        pid: number;
    }>;
    processLogs: (pid: number, options?: ProcessLogReadOptions) => Promise<{
        pid: number;
        chunks: import("@nimbus-sh/core/runtime/process-logs.js").SequencedLogChunk[];
        text: string;
        cursor: number;
        truncated: boolean;
        exit: import("@nimbus-sh/core/runtime/process-logs.js").ProcessExitInfo | null;
    }>;
    listPorts: () => Promise<operations.SerializedPort[]>;
    listApps: () => Promise<operations.ListedApp[]>;
    ensureDurableApp: (input: {
        owner: string;
        preferredPort?: number;
        visibility?: "scoped" | "public";
        name?: string;
    }) => Promise<{
        port: number;
        capability: string | null;
        visibility: "scoped" | "public";
    }>;
    unexposePort: (port: number) => Promise<{
        port: number;
        ok: boolean;
    }>;
    removeDurableApp: (owner: string) => Promise<{
        owner: string;
        removed: boolean;
        port: number | null;
    }>;
    exposeApp: (target: operations.AppTarget, options?: {
        visibility?: "scoped" | "public";
        name?: string;
    } | undefined) => Promise<operations.ExposedAppResult>;
    removeApp: (target: operations.AppTarget) => Promise<{
        owner: string;
        removed: boolean;
        port: number | null;
    }>;
    rotateLink: (target: operations.AppTarget) => Promise<operations.ExposedAppResult>;
    installRuntime: (spec: string, options?: {
        force?: boolean;
    } | undefined) => Promise<import("../runtime/package-manager.js").RuntimeInstallSummary>;
    ensureRuntimes: (specs: string[], options?: {
        force?: boolean;
    } | undefined) => Promise<import("../runtime/package-manager.js").RuntimeInstallSummary[]>;
    listRuntimes: () => Promise<{
        installed: import("@nimbus-sh/core/runtime/installed-runtimes.js").RuntimeSummary[];
        available: import("@nimbus-sh/core/runtime/runtime-package.js").RuntimeAvailability[];
    }>;
    spawnWorker: (workerCode: string, command: string, cwd: string, opts?: import("../workspace-host.js").LongRunningWorkerSpawnOptions | undefined) => Promise<import("../facets/manager.js").SpawnedWorker>;
    routeCapabilityPort: (port: number, capability: string, request: Request<unknown, CfProperties<unknown>>, innerPath: string) => Promise<Response>;
    supervisorOp: (envelope: SupervisorOpEnvelope) => Promise<unknown>;
    onScheduled: (task: HostedRuntimeTask) => Promise<void>;
    attachTerminal: (ws: WebSocket) => Promise<void>;
    terminalFrame: (ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    terminalClose: (ws: WebSocket) => void;
    close: () => Promise<void>;
}>;
export type HostedRuntime = Awaited<ReturnType<typeof composeHostedRuntime>>;
export {};
//# sourceMappingURL=runtime.d.ts.map