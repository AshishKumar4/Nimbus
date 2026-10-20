// facets/process-env.ts — a relaunched process asks its host for the
// environment it was launched with (ask 62).
//
// Nimbus keeps no process's environment in any record, image or generated
// source: what the image store holds, every process on the box can read. A
// relaunch (a re-drive after a reset, an on-failure restart, a durable app's
// relaunch on its port, a dev server's restore) asks the host again, and
// fails, named, when it has no answer.

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { z } from 'zod/v4';

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

const KeptEnvSchema = z.object({ env: z.record(z.string(), z.string()) });

/** The environment a kept row holds, or null when there is none. */
export function keptEnv(row: unknown): Record<string, string> | null {
  const kept = KeptEnvSchema.safeParse(row);
  return kept.success ? kept.data.env : null;
}

/** `value` stored at `record`, with `env` beside it where `keeping` keeps environments: one storage write's entries. */
export function recordWithEnv(keeping: ProcessEnvKeeping | undefined, record: string, value: unknown, env: Record<string, string> | undefined): Record<string, unknown> {
  return keeping === undefined || env === undefined ? { [record]: value } : { [record]: value, [keeping.rowOf(record)]: { env: { ...env } } };
}

/** The keys a delete of `record` removes: the record, and its environment's row. */
export function recordKeys(keeping: ProcessEnvKeeping | undefined, record: string): string[] {
  return keeping === undefined ? [record] : [record, keeping.rowOf(record)];
}

/**
 * The environment the relaunch `request` describes runs with: the host's
 * answer, or an error naming why there is none. Never an empty or a guessed
 * environment.
 */
export async function relaunchEnv(resolve: ResolveProcessEnv | undefined, request: ProcessEnvRequest): Promise<Record<string, string>> {
  const refused = `Nimbus: process ${request.pid} is not relaunched`;
  if (resolve === undefined) throw new Error(`${refused}: this host keeps no process's environment and composes no resolveProcessEnv`);
  let env: Record<string, string> | null;
  try {
    env = await resolve(request);
  } catch (error: unknown) {
    throw new Error(`${refused}: the host's resolveProcessEnv failed: ${errorText(error)}`);
  }
  if (env === null) throw new Error(`${refused}: the host gave no environment for it`);
  return env;
}
