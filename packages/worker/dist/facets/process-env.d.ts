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
/**
 * Where a host that keeps environments itself keeps them: beside each
 * relaunchable record, a row of the session object's own storage, outside
 * the filesystem (FacetManagerHooks.keepProcessEnv). The row is written and
 * deleted in the same storage operation as its record, so neither outlives
 * the other.
 */
export interface ProcessEnvKeeping {
    /** The key of the row that holds `record`'s environment. */
    rowOf(record: string): string;
}
/** The environment a kept row holds, or null when there is none. */
export declare function keptEnv(row: unknown): Record<string, string> | null;
/** Within one storage transaction: `value` at `record`, and `env` beside it where `keeping` keeps environments. */
export declare function putRecord(txn: Pick<DurableObjectTransaction, 'put'>, keeping: ProcessEnvKeeping | undefined, record: string, value: unknown, env: Readonly<Record<string, string>> | undefined): Promise<void>;
/** Within one storage transaction: `record` deleted, and its environment's row with it. Answers whether the record was there. */
export declare function deleteRecord(txn: Pick<DurableObjectTransaction, 'delete'>, keeping: ProcessEnvKeeping | undefined, record: string): Promise<boolean>;
/**
 * The environment the relaunch `request` describes runs with: the host's
 * answer, or an error naming why there is none. Never an empty or a guessed
 * environment.
 */
export declare function relaunchEnv(resolve: ResolveProcessEnv | undefined, request: ProcessEnvRequest): Promise<Record<string, string>>;
//# sourceMappingURL=process-env.d.ts.map