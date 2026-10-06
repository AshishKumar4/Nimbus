/**
 * CiTimings: the one timing history every run is planned with.
 *
 * One object, one row per file in its SQLite. A merge reads, folds and
 * writes in one synchronous transaction, so two runs finishing together
 * cannot lose each other's samples, and a run merges once however often
 * its settlement is retried.
 */
import { DurableObject } from 'cloudflare:workers';
import { type FileTiming, type ReportFile, type TimingHistory, emptyHistory, mergeHistory } from './plan.js';
import type { Env } from './types.js';

export class CiTimings extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, timing TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS merged (run_id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  }

  history(): TimingHistory {
    const history = emptyHistory();
    for (const row of this.ctx.storage.sql.exec<{ name: string; timing: string }>('SELECT name, timing FROM files')) {
      history.files[row.name] = JSON.parse(row.timing) as FileTiming;
    }
    for (const row of this.ctx.storage.sql.exec<{ key: string; value: string }>('SELECT key, value FROM meta')) {
      if (row.key === 'setupMs') history.setupMs = Number(row.value);
      if (row.key === 'updatedAt') history.updatedAt = Number(row.value);
    }
    return history;
  }

  /** Drop files' entries, so the next run measures them afresh (POST /timings/forget). */
  forget(names: string[]): number {
    let removed = 0;
    for (const name of names) removed += this.ctx.storage.sql.exec('DELETE FROM files WHERE name = ?', name).rowsWritten;
    return removed;
  }

  merge(runId: string, files: ReportFile[], setupMs: number | null, now: number): void {
    this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec('SELECT 1 FROM merged WHERE run_id = ?', runId).toArray().length > 0) return;
      const next = mergeHistory(this.history(), files, setupMs, now);
      for (const f of files) {
        const timing = next.files[f.name];
        if (timing) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO files (name, timing) VALUES (?, ?)', f.name, JSON.stringify(timing));
      }
      if (next.setupMs !== null) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'setupMs', String(next.setupMs));
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'updatedAt', String(now));
      this.ctx.storage.sql.exec('INSERT INTO merged (run_id, at) VALUES (?, ?)', runId, now);
    });
  }
}
