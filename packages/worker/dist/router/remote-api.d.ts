import { type NimbusAuthEnv } from '../auth/index.js';
export type NimbusRuntimeName = 'node' | 'bun' | 'npm' | 'git' | 'python' | 'ruby' | 'clang' | 'shell' | (string & {});
export interface NimbusRuntimePolicy {
    preinstall?: string[];
    onDemand?: boolean;
    allow?: NimbusRuntimeName[];
}
export interface NimbusSandboxProfile {
    root?: string;
    runtimes?: NimbusRuntimePolicy;
    tools?: {
        namespace?: string;
        kind?: string;
    };
    preview?: {
        baseUrl?: string;
        pathStyle?: boolean;
    };
}
export interface NimbusConfig {
    endpoint?: string;
    sandboxes?: Record<string, NimbusSandboxProfile>;
}
export interface NimbusRemoteApiConfig {
    /** Enable the remote programmatic sandbox API. */
    enabled?: boolean;
    /** Route prefix. Defaults to `/api/nimbus/v1`. */
    basePath?: string;
    /**
     * Permit unauthenticated remote calls when JWT_SECRET is absent. This is
     * intended only for private development deployments.
     */
    allowLegacy?: boolean;
    /**
     * Required token scopes. Tokens without an explicit `scopes` claim keep the
     * existing full-trust semantics.
     */
    requiredScopes?: string[];
}
export interface NimbusSdkRouterConfig {
    remote?: boolean | NimbusRemoteApiConfig;
    config?: NimbusConfig;
}
interface NimbusSessionRpcStub {
    _rpcReady(options?: {
        preinstall?: string[];
    }): Promise<unknown>;
    _rpcBootProbe(): Promise<unknown>;
    _rpcExec(command: string, options?: Record<string, unknown>): Promise<unknown>;
    _rpcStartProcess(command: string, options?: Record<string, unknown>): Promise<unknown>;
    _rpcRunCode(code: string, options?: Record<string, unknown>): Promise<unknown>;
    _rpcReadFile(path: string): Promise<unknown>;
    _rpcReadFileBytes(path: string): Promise<unknown>;
    _rpcWriteFile(path: string, content: string | Uint8Array): Promise<unknown>;
    _rpcStat(path: string): Promise<unknown>;
    _rpcReaddir(path: string): Promise<unknown>;
    _rpcExists(path: string): Promise<unknown>;
    _rpcMkdir(path: string): Promise<unknown>;
    _rpcDeleteFile(path: string, options?: Record<string, unknown>): Promise<unknown>;
    _rpcInstallRuntime(spec: string, options?: Record<string, unknown>): Promise<unknown>;
    _rpcEnsureRuntimes(specs: string[], options?: Record<string, unknown>): Promise<unknown>;
    _rpcListRuntimes(): Promise<unknown>;
    _rpcListProcesses(): Promise<unknown>;
    _rpcKillProcess(pid: number): Promise<unknown>;
    _rpcWriteProcessInput(pid: number, data: string): Promise<unknown>;
    _rpcEndProcessInput(pid: number): Promise<unknown>;
    _rpcResizeProcess(pid: number, size: {
        columns: number;
        rows: number;
    }): Promise<unknown>;
    _rpcSignalProcess(pid: number, signal: string): Promise<unknown>;
    _rpcProcessLogs(pid: number, options?: {
        cursor?: number;
        lines?: number;
        bytes?: number;
    }): Promise<unknown>;
    _rpcListPorts(): Promise<unknown>;
    _rpcExposePort(port: number): Promise<unknown>;
    _rpcUnexposePort(port: number): Promise<unknown>;
    _rpcDestroy(options?: Record<string, unknown>): Promise<unknown>;
}
interface NimbusSessionNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): NimbusSessionRpcStub;
}
interface NimbusRemoteEnv extends Partial<NimbusAuthEnv> {
    NIMBUS_SESSION?: NimbusSessionNamespace;
}
export declare function handleNimbusRemoteApi(request: Request, env: NimbusRemoteEnv, sdk: NimbusSdkRouterConfig | undefined): Promise<Response | null>;
export {};
//# sourceMappingURL=remote-api.d.ts.map