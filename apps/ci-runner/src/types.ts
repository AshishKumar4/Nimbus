import type { CiRun } from './run.js';
import type { CiShard } from './shard.js';
import type { CiTimings } from './timings.js';
import type { ReportFile, Tier } from './plan.js';

export interface Env {
  CI_RUN: DurableObjectNamespace<CiRun>;
  CI_SHARD: DurableObjectNamespace<CiShard>;
  CI_TIMINGS: DurableObjectNamespace<CiTimings>;
  ARTIFACTS: R2Bucket;
  /** Bearer token every route but /health requires; a Workers secret. */
  CI_TOKEN: string;
  /** The image build the deployment expects (scripts/deploy.mjs sets it). */
  CI_IMAGE_BUILD?: string;
  /** Secrets the suite reads arrive as SUITE_ENV_<NAME> (see shard.ts). */
  [key: string]: unknown;
}

export interface RunSpec {
  runId: string;
  commit: string;
  tree: string;
  tier: Tier;
  shards: number;
  jobs: number;
  timeoutMs: number;
  memoryMax: string;
  only: string[];
  label: string;
  sourceKey: string;
  timingsKey: string;
  createdAt: number;
}

export interface ShardSpec extends RunSpec {
  index: number;
  attempt: number;
}

export interface ShardProgress {
  phase: string;
  pass: number;
  fail: number;
  total: number | null;
  /** Test files running at the last poll, with their RSS. */
  running?: string[];
  memAvailableMiB?: number;
  oomKills?: number | null;
}

export interface ShardReport {
  version: 1;
  tier: Tier;
  jobs: number;
  isolation: string;
  shard: { index: number; count: number; expectedMs: number; universe: string[] } | null;
  elapsedMs: number;
  pass: number;
  fail: number;
  files: ReportFile[];
}

export interface ShardResult {
  /** tested: run-all wrote its report. Anything else is not a test verdict. */
  outcome: 'tested' | 'setup-failed' | 'no-report' | 'runner-crashed';
  error: string | null;
  report: ShardReport | null;
  logKey: string;
  logTail: string;
  /** The commit predates sharding: it ran under the image's run-all. */
  runnerOverlay: boolean;
  times: Record<'containerStart' | 'received' | 'launched' | 'install' | 'test' | 'finished', number | null>;
  vm: Record<'busySeconds' | 'stealSeconds' | 'idleSeconds' | 'groupCpuSeconds', number | null>;
}
