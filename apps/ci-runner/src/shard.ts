/**
 * CiShard: one container running one part of a run.
 *
 * Every step is an alarm, so nothing waits on a request that could be cut:
 * `begin` stores what to run and sets the first alarm; the alarm boots the
 * container, streams the commit's archive from R2 into it, hands it its
 * timings and launches the detached runner (image/ci/shard.mjs); later
 * alarms read its progress until it finishes, then collect the report and
 * log, tell the run, and destroy the container. Any failure of that
 * machinery (no container, a lost exec, a runner that stops reporting) is
 * an infrastructure failure, reported as such and never as a test result.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env, ShardResult, ShardSpec } from './types.js';

const POLL_MS = 5_000;
const POLL_FAILURES = 3;
/**
 * Waits, not failures: the platform's answer while it prepares an instance
 * ("There is no container instance that can be provided to this Durable
 * Object, try again later"), and an instance still on the previous image.
 */
const STALE_IMAGE = 'container runs a previous image';
const NO_CAPACITY = new RegExp(`no container instance that can be provided|${STALE_IMAGE}`, 'i');
const CAPACITY_RETRY_MS = 10_000;
const CAPACITY_WAIT_MS = 12 * 60_000;
const START_MS = 90_000;
const BOOT_MS = 6 * 60_000;
/** Status reads and collection: a lost exec is retried by the next poll. */
const EXEC_MS = 90_000;
const RECEIVE = 'rm -rf /work && mkdir -p /work/src && tar -xzf - -C /work/src && chown -R 1000:1000 /work';

type State = 'idle' | 'booting' | 'running' | 'done' | 'failed' | 'stopped';

export class CiShard extends DurableObject<Env> {
  async begin(spec: ShardSpec): Promise<void> {
    await this.ctx.storage.put({ spec, state: 'booting' satisfies State, beganAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Stop the container, whatever it is doing: the run was cancelled or gave up on it. */
  async stop(): Promise<void> {
    await this.ctx.storage.put('state', 'stopped' satisfies State);
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }

  async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get<State>('state')) ?? 'idle';
    const spec = await this.ctx.storage.get<ShardSpec>('spec');
    if (!spec || (state !== 'booting' && state !== 'running')) return;
    const run = this.env.CI_RUN.getByName(spec.runId);
    try {
      if (state === 'booting') {
        try {
          // An exec can wait on a container that never answers: one alarm
          // did, for its whole 15 minutes. A boot past this is a failure,
          // and the run's one retry starts a fresh container.
          let timer = 0;
          await Promise.race([
            this.boot(spec),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`boot took longer than ${BOOT_MS / 60_000} min`)), BOOT_MS); }),
          ]).finally(() => clearTimeout(timer));
        } catch (error) {
          // Capacity for a new image, or for more instances than are
          // prepared, arrives over minutes: waiting for it is not a failure
          // until the run's boot limit says so.
          const beganAt = (await this.ctx.storage.get<number>('beganAt')) ?? Date.now();
          if (!NO_CAPACITY.test(String(error)) || Date.now() - beganAt > CAPACITY_WAIT_MS) throw error;
          await run.progress(spec.index, spec.attempt, { phase: 'waiting for capacity', pass: 0, fail: 0, total: null });
          await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RETRY_MS);
          return;
        }
      } else if (await this.poll(spec)) return;
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    } catch (error) {
      await this.ctx.storage.put('state', 'failed' satisfies State);
      const message = error instanceof Error ? error.message : String(error);
      // Workers Logs keep this; the run's report keeps only the message.
      console.error(JSON.stringify({ shard: `${spec.runId}/${spec.index}/${spec.attempt}`, state, running: this.ctx.container?.running ?? null, error: message }));
      try { if (this.ctx.container?.running) await this.ctx.container.destroy(); } catch { /* Already gone. */ }
      await run.failed(spec.index, spec.attempt, `shard ${spec.index + 1} attempt ${spec.attempt + 1}: ${message}`);
    }
  }

  private container(): Container {
    if (!this.ctx.container) throw new Error('no container is configured for CiShard');
    return this.ctx.container;
  }

  /** `cmd` in the container, as root; its stdout, or an error carrying its output. */
  private async exec(cmd: string[], options: ContainerExecOptions = {}): Promise<string> {
    const proc = await this.container().exec(cmd, { stderr: 'combined', ...options });
    const out = await proc.output();
    const text = new TextDecoder().decode(out.stdout);
    if (out.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${out.exitCode}: ${text.slice(-2000)}`);
    return text;
  }

  private async boot(spec: ShardSpec): Promise<void> {
    const container = this.container();
    const started = Date.now();
    if (!container.running) container.start({ enableInternet: true });
    // Images before the build id have no /opt/ci/BUILD: as stale as any other.
    // The first exec waits for the container to start, and an exec's abort
    // signal does not end that wait. A start that has not answered in
    // START_MS is destroyed and waited for as capacity: the next start may
    // be placed elsewhere. Measured 2026-10-06 with 35 shards asked for at
    // once: 9 starts hung until a 6 min bound, and each retry started in
    // under 30 s.
    let startTimer = 0;
    const startup = await Promise.race([
      this.exec(['sh', '-c', 'cat /opt/ci/BUILD 2>/dev/null || echo none']).then((out) => ({ out })),
      new Promise<null>((resolve) => { startTimer = setTimeout(() => resolve(null), START_MS); }),
    ]).finally(() => clearTimeout(startTimer));
    if (!startup) {
      await container.destroy().catch(() => {});
      throw new Error(`no container instance that can be provided: not started within ${START_MS / 1000} s`);
    }
    const build = startup.out.trim();
    if (typeof this.env.CI_IMAGE_BUILD === 'string' && build !== this.env.CI_IMAGE_BUILD) {
      await container.destroy();
      throw new Error(`${STALE_IMAGE}: container has build ${build}, the deployment ${this.env.CI_IMAGE_BUILD}`);
    }
    const source = await this.env.ARTIFACTS.get(spec.sourceKey);
    if (!source) throw new Error(`source ${spec.sourceKey} is not in R2`);
    await this.exec(['sh', '-c', RECEIVE], { stdin: source.body });
    const received = Date.now();
    const timings = await this.env.ARTIFACTS.get(spec.timingsKey);
    await this.exec(['bun', '/opt/ci/shard.mjs', 'timings'], { stdin: timings ? timings.body : new Blob(['{"files":{}}']).stream() });
    await this.exec(['bun', '/opt/ci/shard.mjs', 'launch'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        CI_SPEC: JSON.stringify(spec),
        CI_SUITE_ENV: JSON.stringify(suiteEnv(this.env)),
      },
    });
    await this.ctx.storage.put({ state: 'running' satisfies State, boot: { started, received, launched: Date.now() } });
    await this.env.CI_RUN.getByName(spec.runId).progress(spec.index, spec.attempt, { phase: 'launched', pass: 0, fail: 0, total: null });
  }

  /** True once the shard is finished and reported. */
  private async poll(spec: ShardSpec): Promise<boolean> {
    if (!this.container().running) throw new Error('the container stopped before the shard finished');
    let status;
    try {
      status = JSON.parse(await this.exec(['bun', '/opt/ci/shard.mjs', 'status'], { stderr: 'ignore', signal: AbortSignal.timeout(EXEC_MS) }));
      await this.ctx.storage.put('pollFailures', 0);
    } catch (error) {
      // One lost exec is not a lost container: give up after three in a row.
      const failures = ((await this.ctx.storage.get<number>('pollFailures')) ?? 0) + 1;
      await this.ctx.storage.put('pollFailures', failures);
      if (failures >= POLL_FAILURES) throw error;
      return false;
    }
    const run = this.env.CI_RUN.getByName(spec.runId);
    if (status.phase !== 'finished') {
      await run.progress(spec.index, spec.attempt, {
        phase: status.phase, pass: status.pass, fail: status.fail, total: status.total,
        running: status.running, memAvailableMiB: status.memAvailableMiB, oomKills: status.oomKills,
      });
      return false;
    }
    const report = status.outcome === 'tested' ? JSON.parse(await this.exec(['cat', '/work/out/report.json'], { stderr: 'ignore', signal: AbortSignal.timeout(EXEC_MS) })) : null;
    const log = await this.exec(['cat', '/work/out/run.log'], { stderr: 'ignore', signal: AbortSignal.timeout(EXEC_MS) });
    const logKey = `runs/${spec.runId}/shard-${spec.index + 1}-attempt-${spec.attempt + 1}.log`;
    await this.env.ARTIFACTS.put(logKey, log, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    const boot = await this.ctx.storage.get<{ started: number; received: number; launched: number }>('boot');
    const result: ShardResult = {
      outcome: status.outcome,
      error: status.error ?? null,
      report,
      logKey,
      logTail: report ? '' : log.slice(-4000),
      runnerOverlay: status.runnerOverlay === true,
      times: {
        containerStart: boot?.started ?? null,
        received: boot?.received ?? null,
        launched: boot?.launched ?? null,
        install: status.installAt ?? null,
        test: status.testAt ?? null,
        finished: status.finishedAt ?? null,
      },
      vm: {
        busySeconds: status.vmBusySeconds ?? null,
        stealSeconds: status.vmStealSeconds ?? null,
        idleSeconds: status.vmIdleSeconds ?? null,
        groupCpuSeconds: status.groupCpuSeconds ?? null,
      },
    };
    await this.ctx.storage.put('state', 'done' satisfies State);
    await run.finished(spec.index, spec.attempt, result);
    try { await this.container().destroy(); } catch { /* Reported already; it stops on its own. */ }
    return true;
  }
}

/** Workers secrets named SUITE_ENV_<NAME> reach the tests as <NAME>. */
function suiteEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('SUITE_ENV_') && typeof value === 'string') out[key.slice('SUITE_ENV_'.length)] = value;
  }
  return out;
}
