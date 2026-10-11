import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { ProcessLogReadOptions } from '@nimbus-sh/core/runtime/process-logs.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { type SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { ComposedFacetManager, FacetManagerHostHooks } from '../facets/compose.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import * as services from './services.js';
import { HostedSession, type HostedSessionScope } from './session.js';
import { z } from 'zod/v4';
declare const HostedTask: z.ZodEnum<{
    "resident-launch": "resident-launch";
    "resident-keepalive": "resident-keepalive";
    "log-flush": "log-flush";
    "log-janitor": "log-janitor";
    "hosting-watch": "hosting-watch";
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
/** The namespace as one credential sees it (a `VFS`, absolute paths), and the same for another. */
export type RuntimeFiles = ProcessView & {
    as(cred: VfsCred): RuntimeFiles;
};
export declare function composeHostedRuntime(options: HostedRuntimeOptions): Promise<{
    supervisorOp: (envelope: SupervisorOpEnvelope) => Promise<unknown>;
    /** The SDK's session surface for `Nimbus.fromSession`, optionally bound to one shell and identity. */
    session: (scope?: HostedSessionScope) => HostedSession;
    onScheduled: (task: HostedRuntimeTask) => Promise<void>;
    terminalClose: (ws: WebSocket) => void;
    close: () => Promise<void>;
    facets: () => ComposedFacetManager;
    ready: (options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionReadyOptions | undefined) => Promise<{
        ok: true;
        preinstalled: string[];
    }>;
    exec: (command: string, options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionExecOptions | undefined) => Promise<{
        command: string;
        exitCode: number;
        success: boolean;
        duration: number;
        timestamp: number;
        stdout: string;
        stderr: string;
    }>;
    execStream: (command: string, options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionExecOptions | undefined) => Promise<import("@nimbus-sh/core/runtime/exec-stream.js").ExecStream>;
    runCode: (code: string, options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionRunCodeOptions | undefined) => Promise<{
        command: string;
        exitCode: number;
        success: boolean;
        duration: number;
        timestamp: number;
        stdout: string;
        stderr: string;
    }>;
    startProcess: (command: string, options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionExecOptions | undefined) => Promise<{
        command: string;
        pid: number;
        process: {
            pid: number;
            command: string;
            argv: string[];
            cwd: string;
            state: string;
            exitCode: number | null;
            startTime: number;
            endTime: number | null;
            longRunning: boolean;
            attachedTty: boolean;
            execId?: string | undefined;
        };
        ports: {
            port: number;
            pid: number;
            registeredAt: number;
            capability: string;
            execId?: string | undefined;
        }[];
        startedAt: number;
    }>;
    listProcesses: () => Promise<{
        pid: number;
        command: string;
        argv: string[];
        cwd: string;
        state: string;
        exitCode: number | null;
        startTime: number;
        endTime: number | null;
        longRunning: boolean;
        attachedTty: boolean;
        execId?: string | undefined;
    }[]>;
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
        chunks: {
            seq: number;
            ts: number;
            stream: "stdout" | "stderr";
            data: string;
            binary?: boolean | undefined;
        }[];
        text: string;
        cursor: number;
        truncated: boolean;
        exit: {
            code: number;
            at: number;
            reason?: string | undefined;
        } | null;
    }>;
    listPorts: () => Promise<{
        port: number;
        pid: number;
        registeredAt: number;
        capability: string;
        execId?: string | undefined;
    }[]>;
    listApps: () => Promise<{
        owner: string;
        name: string | null;
        port: number | null;
        pid: number | null;
        status: "running" | "starting" | "stopped" | "failed";
        visibility: "scoped" | "public";
        capability: string | null;
        restart: "never" | "on-failure";
        diagnostic: string | null;
        url: string | null;
        execId?: string | undefined;
    }[]>;
    ensureDurableApp: (input: import("@nimbus-sh/core/runtime/session-protocol.js").SessionDurableAppOptions) => Promise<{
        port: number;
        capability: string | null;
        visibility: import("../session/port-capability.js").PortVisibility;
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
    exposeApp: (target: import("@nimbus-sh/core/runtime/session-protocol.js").SessionAppTarget, options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionExposeOptions | undefined) => Promise<{
        owner: string;
        name: string | null;
        port: number;
        pid: number | null;
        capability: string | null;
        visibility: "scoped" | "public";
        url: string | null;
        execId?: string | undefined;
    }>;
    removeApp: (target: import("@nimbus-sh/core/runtime/session-protocol.js").SessionAppTarget) => Promise<{
        removed: boolean;
        owner: string;
        port: number | null;
    }>;
    rotateLink: (target: import("@nimbus-sh/core/runtime/session-protocol.js").SessionAppTarget) => Promise<{
        owner: string;
        name: string | null;
        port: number;
        pid: number | null;
        capability: string | null;
        visibility: "scoped" | "public";
        url: string | null;
        execId?: string | undefined;
    }>;
    installRuntime: (spec: string, options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionRuntimeInstallOptions | undefined) => Promise<{
        spec: string;
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    ensureRuntimes: (specs: string[], options?: import("@nimbus-sh/core/runtime/session-protocol.js").SessionRuntimeInstallOptions | undefined) => Promise<{
        spec: string;
        exitCode: number;
        stdout: string;
        stderr: string;
    }[]>;
    listRuntimes: () => Promise<{
        installed: {
            name: string;
            version: string;
            root: string;
            abi: string;
            bins: string[];
            sizeBytes: number;
            license: string;
        }[];
        available: {
            name: string;
            abi: string;
            defaultVersion: string;
            versions: {
                version: string;
                sizeBytes: number;
                license: string;
            }[];
        }[];
    }>;
    spawnWorker: (workerCode: string, command: string, cwd: string, opts?: import("../workspace-host.js").LongRunningWorkerSpawnOptions | undefined) => Promise<import("../facets/manager.js").SpawnedWorker>;
    routeCapabilityPort: (port: number, capability: string, request: Request<unknown, CfProperties<unknown>>, innerPath: string) => Promise<Response>;
    attachTerminal: (ws: WebSocket) => Promise<void>;
    terminalFrame: (ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
    workspace: NimbusWorkspace;
    terminal: WebSocketTerminal;
    files: RuntimeFiles;
    runtimes: import("@nimbus-sh/core/runtime/runtime-manager.js").RuntimeManager;
}>;
export type HostedRuntime = Awaited<ReturnType<typeof composeHostedRuntime>>;
export {};
//# sourceMappingURL=runtime.d.ts.map