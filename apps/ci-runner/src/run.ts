/**
 * CiRun: one run of the unit suite on one commit, split across shards.
 *
 * It dispatches each shard to a CiShard (one container each), records their
 * progress, retries a shard once when the infrastructure failed it (a
 * container that never started, an exec that was lost, a shard that stopped
 * reporting), and only that, and turns the shards' reports into one verdict:
 *
 *   pass   every selected file ran exactly once and passed;
 *   fail   every selected file ran exactly once and at least one failed;
 *   error  the run could not grade the commit: a shard failed twice for
 *          infrastructure, the commit's install or runner failed, or the
 *          shards' files do not add up to the selection. Never a test result.
 */
import { DurableObject } from 'cloudflare:workers';
import { type ReportFile, TIMINGS_NAME } from './plan.js';
import type { Env, RunSpec, ShardProgress, ShardReport, ShardResult } from './types.js';

const WATCHDOG_MS = 30_000;
/** A shard reports every few seconds once launched; booting includes the image pull. */
const STALL_MS = { booting: 15 * 60_000, running: 5 * 60_000 };
const RUN_DEADLINE_MS = 90 * 60_000;
const INFRA_ATTEMPTS = 2;

/** Containers price list (developers.cloudflare.com/containers/pricing), standard-4. */
const PRICE = { vcpuSecond: 0.00002, gibSecond: 0.0000025, gbSecond: 0.00000007, gib: 12, gb: 20 };

type ShardState = 'booting' | 'running' | 'done' | 'infra-failed' | 'stopped';

interface ShardRow {
  index: number;
  attempt: number;
  state: ShardState;
  progress: ShardProgress | null;
  updatedAt: number;
  errors: string[];
  result: Omit<ShardResult, 'report'> | null;
  reportKey: string | null;
  finishedAt: number | null;
}

export interface RunStatus {
  runId: string;
  spec: RunSpec;
  state: 'running' | 'done';
  verdict: 'pass' | 'fail' | 'error' | null;
  problems: string[];
  shards: ShardRow[];
  summary: RunSummary | null;
  reportKey: string | null;
}

export interface RunSummary {
  files: number;
  pass: number;
  fail: number;
  failed: ReportFile[];
  wallMs: number;
  slowest: Pick<ReportFile, 'name' | 'wallMs' | 'cpuMs' | 'tier'>[];
  testCpuSeconds: number;
  vmBusySeconds: number;
  vmStealSeconds: number;
  containerSeconds: number;
  setupMsMedian: number | null;
  runnerOverlay: boolean;
  costUsd: { cpu: number; memory: number; disk: number; total: number };
}

function newRow(index: number, attempt: number, errors: string[]): ShardRow {
  return { index, attempt, state: 'booting', progress: null, updatedAt: Date.now(), errors, result: null, reportKey: null, finishedAt: null };
}

export class CiRun extends DurableObject<Env> {
  // Concurrency: storage calls keep this object's input gate shut, but an
  // RPC or an R2 call opens it, and another call can run in between. So a
  // method decides from storage alone, writes, and only then calls out;
  // after a call out it reads storage again before writing.

  async create(spec: RunSpec): Promise<void> {
    if (await this.ctx.storage.get('spec')) throw new Error(`run ${spec.runId} exists`);
    const rows = Object.fromEntries(Array.from({ length: spec.shards }, (_, index) => [`shard:${index}`, newRow(index, 0, [])]));
    await this.ctx.storage.put({ spec, state: 'running', problems: [], ...rows });
    // The watchdog first: a run whose dispatch fails is still watched.
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    await Promise.all(Array.from({ length: spec.shards }, (_, index) => this.begin(spec, index, 0)));
  }

  /** Start attempt `attempt` of shard `index`, whose row is written already. */
  private async begin(spec: RunSpec, index: number, attempt: number): Promise<void> {
    try {
      await this.env.CI_SHARD.getByName(`${spec.runId}/${index}/${attempt}`).begin({ ...spec, index, attempt });
    } catch (error) {
      await this.failed(index, attempt, `shard ${index + 1} attempt ${attempt + 1}: could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async row(index: number): Promise<ShardRow | undefined> {
    return this.ctx.storage.get<ShardRow>(`shard:${index}`);
  }

  async progress(index: number, attempt: number, progress: ShardProgress): Promise<void> {
    const row = await this.row(index);
    if (!row || row.attempt !== attempt || (row.state !== 'booting' && row.state !== 'running')) return;
    // Until it launches, a shard is booting: waiting for capacity included.
    const state = progress.phase === 'waiting for capacity' ? row.state : 'running';
    await this.ctx.storage.put(`shard:${index}`, { ...row, state, progress, updatedAt: Date.now() });
  }

  /** The shard row while attempt `attempt` of it can still report, else null. */
  private async live(index: number, attempt: number): Promise<ShardRow | null> {
    const row = await this.row(index);
    if (!row || row.attempt !== attempt || (row.state !== 'booting' && row.state !== 'running')) return null;
    return (await this.ctx.storage.get('state')) === 'running' ? row : null;
  }

  async finished(index: number, attempt: number, result: ShardResult): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    if (!spec || !(await this.live(index, attempt))) return;
    // The runner itself crashing is ours, not the commit's: retried like infrastructure.
    if (result.outcome === 'runner-crashed') return this.failed(index, attempt, `runner crashed: ${result.error}`);
    let reportKey: string | null = null;
    if (result.report) {
      reportKey = `runs/${spec.runId}/shard-${index + 1}-attempt-${attempt + 1}.json`;
      await this.env.ARTIFACTS.put(reportKey, JSON.stringify(result.report));
    }
    // The put let other calls in: the watchdog may have retried this shard.
    const row = await this.live(index, attempt);
    if (!row) return;
    const { report, ...rest } = result;
    await this.ctx.storage.put(`shard:${index}`, {
      ...row, state: 'done', updatedAt: Date.now(), finishedAt: Date.now(), result: rest, reportKey,
      progress: report ? { phase: 'finished', pass: report.pass, fail: report.fail, total: report.files.length } : row.progress,
    });
    await this.settle(spec);
  }

  async failed(index: number, attempt: number, error: string): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    const row = await this.live(index, attempt);
    if (!spec || !row) return;
    const errors = [...row.errors, error];
    if (attempt + 1 < INFRA_ATTEMPTS) {
      await this.ctx.storage.put(`shard:${index}`, newRow(index, attempt + 1, errors));
      await this.begin(spec, index, attempt + 1);
      return;
    }
    await this.ctx.storage.put(`shard:${index}`, { ...row, state: 'infra-failed', errors, updatedAt: Date.now(), finishedAt: Date.now() });
    await this.settle(spec);
  }

  async cancel(reason: string): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    if (!spec || (await this.ctx.storage.get('state')) !== 'running') return;
    // Every unfinished shard is stopped in storage before anything is
    // called: a report arriving meanwhile finds its shard stopped.
    const problems = await this.ctx.storage.get<string[]>('problems') ?? [];
    await this.ctx.storage.put('problems', [...problems, reason]);
    const stopping: ShardRow[] = [];
    for (let index = 0; index < spec.shards; index++) {
      const row = await this.row(index);
      if (!row || (row.state !== 'booting' && row.state !== 'running')) continue;
      await this.ctx.storage.put(`shard:${index}`, { ...row, state: 'stopped', finishedAt: Date.now() });
      stopping.push(row);
    }
    await this.settle(spec);
    await Promise.all(stopping.map((row) => this.env.CI_SHARD.getByName(`${spec.runId}/${row.index}/${row.attempt}`).stop().catch(() => {})));
  }

  async alarm(): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    if (!spec || (await this.ctx.storage.get('state')) !== 'running') return;
    if (Date.now() - spec.createdAt > RUN_DEADLINE_MS) {
      await this.cancel(`the run passed its ${RUN_DEADLINE_MS / 60_000} min deadline`);
      return;
    }
    for (let index = 0; index < spec.shards; index++) {
      const row = await this.row(index);
      if (!row || (row.state !== 'booting' && row.state !== 'running')) continue;
      if (Date.now() - row.updatedAt > STALL_MS[row.state]) {
        await this.failed(index, row.attempt, `shard ${index + 1} attempt ${row.attempt + 1}: no progress for ${STALL_MS[row.state] / 60_000} min while ${row.state}`);
        await this.env.CI_SHARD.getByName(`${spec.runId}/${index}/${row.attempt}`).stop().catch(() => {});
      }
    }
    if ((await this.ctx.storage.get('state')) === 'running') await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  /** Once every shard is terminal: the verdict, the run report, and the timing history. */
  private async settle(spec: RunSpec): Promise<void> {
    const rows = await Promise.all(Array.from({ length: spec.shards }, (_, i) => this.row(i)));
    if (rows.some((row) => !row || row.state === 'booting' || row.state === 'running')) return;
    if ((await this.ctx.storage.get('state')) !== 'running') return;
    // Claimed before any call out: nothing changes the run after this.
    await this.ctx.storage.put('state', 'settling');
    const problems = [...(await this.ctx.storage.get<string[]>('problems') ?? [])];
    const reports: ShardReport[] = [];
    for (const row of rows as ShardRow[]) {
      if (row.state === 'infra-failed') {
        const seen = row.progress ? `; last seen in ${row.progress.phase} with ${row.progress.memAvailableMiB ?? '?'} MiB available, ${row.progress.oomKills ?? '?'} OOM kills, running ${row.progress.running?.join(', ') || 'nothing'}` : '';
        problems.push(`shard ${row.index + 1}: infrastructure failed ${row.errors.length} time(s): ${row.errors.join(' | ')}${seen}`);
      }
      else if (row.state === 'done' && row.result?.outcome !== 'tested') problems.push(`shard ${row.index + 1}: ${row.result?.outcome}: ${row.result?.error ?? ''} ${row.result?.logTail.slice(-1500) ?? ''}`.trim());
      else if (row.reportKey) {
        const object = await this.env.ARTIFACTS.get(row.reportKey);
        if (object) reports.push(await object.json<ShardReport>());
        else problems.push(`shard ${row.index + 1}: report ${row.reportKey} missing from R2`);
      }
    }
    // Coverage: every shard saw the same selection, and their parts add up to it exactly once.
    const files = reports.flatMap((r) => r.files);
    for (const f of files.filter((file) => file.launchError)) problems.push(`${f.name} never started: ${f.launchError}`);
    if (problems.length === 0) {
      const universe = reports[0]?.shard?.universe ?? [];
      const selected = new Set(universe);
      if (reports.some((r) => JSON.stringify(r.shard?.universe) !== JSON.stringify(universe))) problems.push('shards disagree on the selected files');
      const seen = new Map<string, number>();
      for (const f of files) seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
      const twice = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
      const missing = universe.filter((name) => !seen.has(name));
      const extra = [...seen.keys()].filter((name) => !selected.has(name));
      if (twice.length) problems.push(`ran more than once: ${twice.join(', ')}`);
      if (missing.length) problems.push(`never ran: ${missing.join(', ')}`);
      if (extra.length) problems.push(`ran outside the selection: ${extra.join(', ')}`);
      if (universe.length === 0) problems.push('the selection is empty');
    }
    const failed = files.filter((f) => !f.ok);
    const verdict = problems.length > 0 ? 'error' : failed.length > 0 ? 'fail' : 'pass';
    const done = rows as ShardRow[];
    const sum = (pick: (row: ShardRow) => number | null | undefined) => done.reduce((s, row) => s + (pick(row) ?? 0), 0);
    const containerSeconds = sum((row) => row.result?.times.containerStart && row.finishedAt ? (row.finishedAt - row.result.times.containerStart) / 1000 : 0);
    const vmBusySeconds = sum((row) => row.result?.vm.busySeconds);
    const setups = done.map((row) => row.result?.times.test && row.result.times.containerStart ? row.result.times.test - row.result.times.containerStart : null).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const cost = {
      cpu: vmBusySeconds * PRICE.vcpuSecond,
      memory: containerSeconds * PRICE.gib * PRICE.gibSecond,
      disk: containerSeconds * PRICE.gb * PRICE.gbSecond,
    };
    const finishedAt = Date.now();
    const summary: RunSummary = {
      files: files.length,
      pass: files.length - failed.length,
      fail: failed.length,
      // The status keeps tails; the report in R2 keeps each failure's whole output.
      failed: failed.map(({ stdout, stderr, ...f }) => f),
      wallMs: finishedAt - spec.createdAt,
      slowest: [...files].sort((a, b) => b.wallMs - a.wallMs).slice(0, 15).map(({ name, wallMs, cpuMs, tier }) => ({ name, wallMs, cpuMs, tier })),
      testCpuSeconds: files.reduce((s, f) => s + (f.cpuMs ?? 0), 0) / 1000,
      vmBusySeconds,
      vmStealSeconds: sum((row) => row.result?.vm.stealSeconds),
      containerSeconds,
      setupMsMedian: setups.length ? setups[Math.floor(setups.length / 2)] : null,
      runnerOverlay: done.some((row) => row.result?.runnerOverlay),
      costUsd: { ...cost, total: cost.cpu + cost.memory + cost.disk },
    };
    const reportKey = `runs/${spec.runId}/report.json`;
    await this.env.ARTIFACTS.put(reportKey, JSON.stringify({ spec, verdict, problems, summary, shards: done, files }));
    await this.ctx.storage.put({ state: 'done', verdict, problems, summary, reportKey, finishedAt });
    await this.ctx.storage.deleteAlarm();
    if (files.length > 0) await this.env.CI_TIMINGS.getByName(TIMINGS_NAME).merge(spec.runId, files, summary.setupMsMedian, finishedAt);
  }

  async status(): Promise<RunStatus | null> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    if (!spec) return null;
    const shards = await Promise.all(Array.from({ length: spec.shards }, (_, i) => this.row(i)));
    return {
      runId: spec.runId,
      spec,
      // Settling is still running to a client: the verdict is not out yet.
      state: (await this.ctx.storage.get<string>('state')) === 'done' ? 'done' : 'running',
      verdict: (await this.ctx.storage.get<RunStatus['verdict']>('verdict')) ?? null,
      problems: (await this.ctx.storage.get<string[]>('problems')) ?? [],
      shards: shards.filter((row): row is ShardRow => row !== undefined),
      summary: (await this.ctx.storage.get<RunSummary>('summary')) ?? null,
      reportKey: (await this.ctx.storage.get<string>('reportKey')) ?? null,
    };
  }
}
