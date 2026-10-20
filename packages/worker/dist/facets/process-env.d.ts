import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
/** What a relaunch asks its host for: the process it relaunches, and the record that relaunches it. */
export interface ProcessEnvRequest {
    /** The pid the record names: the process being relaunched, of this or an earlier instance. */
    pid: number;
    /** Its exec id (`ProcessEntry.execId`), when it has one. */
    execId?: string;
    /** Who it runs as. */
    cred: VfsCred;
    /** The record's storage key (`resident-launch:<pid>`, `dev-server:<pid>`): what a keeper keys by. */
    record: string;
}
export type ResolveProcessEnv = (request: ProcessEnvRequest) => Promise<Record<string, string> | null>;
/** Where a host keeps the environments it answers resolveProcessEnv from (FacetManagerHooks.keepProcessEnv). */
export interface ProcessEnvKeeper {
    /** `record` was written for a launch with `env`. */
    remember(record: string, env: Record<string, string>): Promise<void>;
    /** `record` is gone: nothing relaunches from it. */
    forget(record: string): Promise<void>;
}
/**
 * The environment the relaunch `request` describes runs with: the host's
 * answer, or an error naming why there is none. Never an empty or a guessed
 * environment.
 */
export declare function relaunchEnv(resolve: ResolveProcessEnv | undefined, request: ProcessEnvRequest): Promise<Record<string, string>>;
//# sourceMappingURL=process-env.d.ts.map