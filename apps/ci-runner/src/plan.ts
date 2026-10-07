/**
 * Shard planning and the timing history it reads.
 *
 * Every finished run folds its passing files' wall and CPU times into the
 * history one CiTimings object keeps (src/timings.ts), so concurrent runs
 * cannot overwrite each other's merges. A run's shards receive a copy, and
 * run-all's `--shard I/N --timings` partitions the commit's own file list
 * with it (tests/unit/run-all.mjs), so the partition is computed where the
 * file list is known. Here it decides only how many shards a run gets.
 */

export type Tier = 'fast' | 'slow' | 'all';

export interface FileTiming {
  /** The median of `recent`: one slow or fast run does not move it. */
  wallMs: number;
  cpuMs: number | null;
  memoryPeakBytes: number | null;
  tier: 'fast' | 'slow' | 'quiet-cpu';
  serial: boolean;
  /** Passing samples merged; 0 for a timeout's lower bound. */
  samples: number;
  /** The last RECENT passing samples, oldest first. */
  recent?: { wallMs: number; cpuMs: number | null; memoryPeakBytes: number | null }[];
  updatedAt: number;
}

const RECENT = 5;

export interface TimingHistory {
  version: 1;
  updatedAt: number;
  /** Container start to the first test, per shard: receive, install, launch. */
  setupMs: number | null;
  files: Record<string, FileTiming>;
}

/** The CiTimings object every run reads and merges into. */
export const TIMINGS_NAME = 'unit';
export const MAX_SHARDS = 60;
export const DEFAULT_JOBS = 4;
/**
 * The per-shard planning target, container start to verdict. Six minutes
 * gives runs of about ten: a file runs up to 40% slower in a busy pool
 * than its history says, whole files do not divide evenly, and a shard
 * waits on its longest (dynamic-worker-protocol-model-nested, 5 min).
 * Measured 2026-10-06: 5-7 shards ran 6.7-14 min; 16 ran 6.2 min. The
 * memory a shard bills is most of the difference in cost: $0.14-0.20.
 */
export const TARGET_MS = 6 * 60_000;

export function emptyHistory(): TimingHistory {
  return { version: 1, updatedAt: 0, setupMs: null, files: {} };
}

/**
 * Enough shards that the expected per-shard time fits the target after
 * setup, with 30% slack: whole files do not divide evenly, and history
 * lags a commit that made a file slower. With no history,
 * 16: the first run is the one that measures.
 */
export function defaultShards(history: TimingHistory, tier: Tier, jobs: number, only: string[] = [], commitFiles: string[] = []): number {
  // The history is every branch's: when the client names the commit's test
  // files, only those count, and one the history lacks costs the median.
  const inCommit = new Set(commitFiles);
  const selected = (name: string) => only.length === 0 || only.includes(name) || only.includes(name.replace(/\.mjs$/, ''));
  const files = Object.entries(history.files)
    .filter(([name, f]) => tier === 'all' || (tier === 'fast') === (f.tier === 'fast'))
    .filter(([name]) => selected(name) && (inCommit.size === 0 || inCommit.has(name)))
    .map(([, f]) => f);
  if (files.length === 0) return only.length > 0 ? Math.min(only.length, 16) : 16;
  const costs = files.map((f) => Math.max(f.wallMs, f.cpuMs ?? 0)).sort((a, b) => a - b);
  const unmeasured = [...inCommit].filter((name) => !history.files[name] && selected(name));
  files.push(...unmeasured.map(() => ({ ...files[0], wallMs: costs[Math.floor(costs.length / 2)], cpuMs: null, serial: false })));
  // As run-all balances: a job slot is one vCPU, so a pooled file costs
  // max(wall, CPU); a serial one has every vCPU and costs its wall time.
  const pooled = files.filter((f) => !f.serial).reduce((sum, f) => sum + Math.max(f.wallMs, f.cpuMs ?? 0), 0) / jobs;
  const serial = files.filter((f) => f.serial).reduce((sum, f) => sum + f.wallMs, 0);
  // No shard can finish before its longest file: past that, more shards
  // cost memory-seconds and save nothing. A timeout's bound (no passing
  // sample) is most often a hang, which no plan finishes sooner.
  const longest = Math.max(...files.filter((f) => f.samples > 0).map((f) => (f.serial ? f.wallMs : Math.max(f.wallMs, (f.cpuMs ?? 0) / jobs))), 0);
  const budget = Math.max(60_000, TARGET_MS - (history.setupMs ?? 120_000), longest);
  const shards = Math.ceil((pooled + serial) / (budget * 0.7));
  return Math.max(1, Math.min(MAX_SHARDS, files.length, shards));
}

export interface ReportFile {
  name: string;
  ok: boolean;
  tier: FileTiming['tier'];
  serial: boolean;
  wallMs: number;
  cpuMs: number | null;
  memoryPeakBytes: number | null;
  /** Commands the file's process tree ran (sampled), e.g. workerd. */
  commands?: string[];
  /** The isolation could not start the file: no test ran. */
  launchError?: string;
  reason?: string;
  stdoutTail?: string;
  stderrTail?: string;
  /** A failing file's whole output, as run-all captured it (up to 1 MiB each). */
  stdout?: string;
  stderr?: string;
}

/**
 * Fold one run into the history: a passing file's times join its last few,
 * and its entry is their median (a failed file's time says how it failed, not how long it
 * takes, except that a timeout bounds a file that has never passed). Files the run did not see
 * keep their entry. Runs of a few files (--only) count too: a file's time
 * alone is still its time.
 */
export function mergeHistory(history: TimingHistory, files: ReportFile[], setupMs: number | null, now: number): TimingHistory {
  const next: TimingHistory = { ...history, files: { ...history.files }, updatedAt: now };
  for (const f of files) {
    const before = next.files[f.name];
    if (!f.ok) {
      // A file killed at its timeout with no passing sample yet ran at least
      // that long: a lower bound that keeps the next partition from treating
      // it as cheap. Once it has passed, a timeout is a hang, not its
      // duration (one 900 s hang of a 3 s file planned it as a shard of its
      // own), and only its tier is kept.
      const timedOut = /exceeded --timeout/.test(f.reason ?? '');
      if (before && before.samples > 0) next.files[f.name] = { ...before, tier: f.tier, serial: f.serial };
      else if (timedOut) {
        next.files[f.name] = {
          wallMs: Math.max(before?.wallMs ?? 0, f.wallMs), cpuMs: Math.max(before?.cpuMs ?? 0, f.cpuMs ?? 0),
          memoryPeakBytes: f.memoryPeakBytes, tier: f.tier, serial: f.serial, samples: 0, updatedAt: now,
        };
      }
      continue;
    }
    // An entry with no passing sample (a timeout's lower bound) is replaced.
    const known = before && before.samples > 0 ? before : undefined;
    const recent = [...(known?.recent ?? (known ? [{ wallMs: known.wallMs, cpuMs: known.cpuMs, memoryPeakBytes: known.memoryPeakBytes }] : [])),
      { wallMs: f.wallMs, cpuMs: f.cpuMs, memoryPeakBytes: f.memoryPeakBytes }].slice(-RECENT);
    const median = (values: (number | null)[]) => {
      const known_ = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
      return known_.length === 0 ? null : known_[Math.floor(known_.length / 2)];
    };
    next.files[f.name] = {
      wallMs: median(recent.map((r) => r.wallMs)) as number,
      cpuMs: median(recent.map((r) => r.cpuMs)),
      memoryPeakBytes: median(recent.map((r) => r.memoryPeakBytes)),
      tier: f.tier,
      serial: f.serial,
      samples: (known?.samples ?? 0) + 1,
      recent,
      updatedAt: now,
    };
  }
  if (setupMs !== null) next.setupMs = history.setupMs === null ? setupMs : Math.round((history.setupMs + setupMs) / 2);
  return next;
}
