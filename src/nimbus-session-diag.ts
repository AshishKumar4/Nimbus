/**
 * nimbus-session-diag.ts — heap probe + W5 OOM-ring persistence helpers.
 *
 * Extracted from src/nimbus-session.ts per
 * audit/sections/SESSION-REFACTOR-PLAN.md S10.
 *
 * Surfaces:
 *   - readNodeMem() — process.memoryUsage() if available; null otherwise.
 *   - readPerfMem() — performance.memory if available; null otherwise.
 *   - sampleMemory(host) — read + update peak trackers (no I/O, microseconds).
 *   - rehydrateRingFromStorage(host, ctx) — load OOM ring snapshot at boot.
 *   - persistRing(host, ctx) — async put with redundant-write skip.
 *
 * Per DEFECT-D1: ctx is taken as a separate explicit arg.
 */

import {
  rehydrateFromStorage, snapshotForStorage, getFailures,
} from './oom-discriminator.js';
import { W5_RING_STORAGE_KEY } from './nimbus-session-keys.js';

/**
 * Minimal host shape. Per plan §IX.1 b': fields drop `private` on the class.
 */
export interface DiagHost {
  _diagPeakRss: number;
  _diagPeakHeapUsed: number;
  _diagPeakAt: number;
  _diagSampleCount: number;
  _w5LastPersistAt: number;
  _w5LastPersistRingSize: number;
}

export function readNodeMem(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number } | null {
  try {
    const g: any = globalThis as any;
    if (g.process && typeof g.process.memoryUsage === 'function') {
      const mu = g.process.memoryUsage();
      return {
        rss: mu.rss | 0,
        heapTotal: mu.heapTotal | 0,
        heapUsed: mu.heapUsed | 0,
        external: mu.external | 0,
        arrayBuffers: mu.arrayBuffers | 0,
      };
    }
  } catch { /* ignore */ }
  return null;
}

export function readPerfMem(): { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number } | null {
  try {
    const g: any = globalThis as any;
    if (g.performance && g.performance.memory) {
      return {
        jsHeapSizeLimit: g.performance.memory.jsHeapSizeLimit | 0,
        totalJSHeapSize: g.performance.memory.totalJSHeapSize | 0,
        usedJSHeapSize: g.performance.memory.usedJSHeapSize | 0,
      };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Sample current heap and update peak trackers. Idempotent on call
 * count beyond `_diagSampleCount`. Safe to call from any code path
 * (request handler, install/bundle progress callbacks) — does NO
 * I/O, NO async work, returns immediately. Cost: one process.memoryUsage()
 * which is microseconds.
 */
export function sampleMemory(host: DiagHost): void {
  host._diagSampleCount++;
  const mu = readNodeMem();
  if (!mu) return;
  const now = Date.now();
  if (mu.rss > host._diagPeakRss) {
    host._diagPeakRss = mu.rss;
    host._diagPeakAt = now;
  }
  if (mu.heapUsed > host._diagPeakHeapUsed) {
    host._diagPeakHeapUsed = mu.heapUsed;
    // _diagPeakAt is whichever is most recent of the two; prefer
    // heapUsed peaks since rss is a lagging indicator that may include
    // freed-but-not-returned pages.
    host._diagPeakAt = now;
  }
}

/**
 * W5 Lever 5: rehydrate the OOM ring from storage (best-effort).
 * Survives DO hibernation; lets cf-tail-style forensics include
 * pre-hibernate failures. Fail-soft on garbage / missing.
 */
export async function rehydrateRingFromStorage(_host: DiagHost, ctx: any): Promise<void> {
  try {
    const blob = await ctx.storage.get(W5_RING_STORAGE_KEY);
    if (blob) rehydrateFromStorage(blob);
  } catch (_e: any) {
    // Storage read can fail on a fresh isolate or after schema reset.
    // The ring stays empty — perfectly OK.
  }
}

/**
 * Snapshot the ring + persist to ctx.storage. Async; callers should
 * pass the returned promise to ctx.waitUntil so close-handler return
 * doesn't race the put. Skips redundant writes.
 */
export function persistRing(host: DiagHost, ctx: any): Promise<void> | null {
  try {
    const failures = getFailures();
    if (failures.length === 0) return null;
    if (failures.length === host._w5LastPersistRingSize) return null;
    const snap = snapshotForStorage();
    host._w5LastPersistRingSize = failures.length;
    host._w5LastPersistAt = Date.now();
    // ctx.storage.put returns a promise; await semantics for the
    // caller's waitUntil. Errors here are non-fatal — log and move on.
    return ctx.storage.put(
      W5_RING_STORAGE_KEY,
      snap,
    ).catch((e: any) => {
      console.warn('[nimbus/W5] ring persist failed:', e?.message);
    });
  } catch (e: any) {
    console.warn('[nimbus/W5] ring persist threw:', e?.message);
    return null;
  }
}
