/**
 * @nimbus-sh/sdk/flue - Flue sandbox connector for Nimbus sandboxes.
 *
 * Flue owns the agent harness. Nimbus owns the sandbox. This adapter maps a
 * `NimbusSandbox` handle to Flue's `SandboxFactory`/`SandboxApi` contract
 * without making `@flue/runtime` a hard dependency of the core SDK.
 */
import type { NimbusSandbox } from './sandbox.js';
export interface NimbusFlueFileStat {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtime: Date;
}
export interface NimbusFlueSessionEnv {
    exec(command: string, options?: NimbusFlueExecOptions): Promise<NimbusFlueShellResult>;
    readFile(path: string): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    stat(path: string): Promise<NimbusFlueFileStat>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    rm(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    cwd: string;
    resolvePath(path: string): string;
}
export interface NimbusFlueShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface NimbusFlueExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
}
export interface NimbusFlueSandboxApi {
    readFile(path: string): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    stat(path: string): Promise<NimbusFlueFileStat>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    rm(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    exec(command: string, options?: NimbusFlueExecOptions): Promise<NimbusFlueShellResult>;
}
export interface NimbusFlueRuntime<SessionEnv = NimbusFlueSessionEnv> {
    createSandboxSessionEnv(api: NimbusFlueSandboxApi, cwd: string): SessionEnv;
}
export interface NimbusFlueFactory<SessionEnv = NimbusFlueSessionEnv> {
    createSessionEnv(options: {
        id: string;
        cwd?: string;
    }): Promise<SessionEnv>;
}
export interface NimbusFlueOptions<SessionEnv = NimbusFlueSessionEnv> {
    cwd?: string;
    runtime?: NimbusFlueRuntime<SessionEnv>;
}
export declare function nimbusFlue<SessionEnv = NimbusFlueSessionEnv>(sandbox: NimbusSandbox, options?: NimbusFlueOptions<SessionEnv>): NimbusFlueFactory<SessionEnv>;
export declare class NimbusFlueApi implements NimbusFlueSandboxApi {
    private readonly sandbox;
    constructor(sandbox: NimbusSandbox);
    readFile(path: string): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    stat(path: string): Promise<NimbusFlueFileStat>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, _options?: {
        recursive?: boolean;
    }): Promise<void>;
    rm(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    exec(command: string, options?: NimbusFlueExecOptions): Promise<NimbusFlueShellResult>;
}
//# sourceMappingURL=flue.d.ts.map