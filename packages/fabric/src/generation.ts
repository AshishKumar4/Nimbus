/**
 * generation.ts — the isolate-generation clock, and the deferred
 * reconciliation that runs once per fresh incarnation.
 *
 * Workerd hibernates Durable Objects between requests to free memory. On
 * wake, the new isolate must rebuild its in-memory state from SQL — but it
 * also needs to know "is this the same lifecycle as before, or did workerd
 * recycle me?" That distinction matters for recovery (warmJoin vs cold init)
 * and is captured by the isolate generation, a counter persisted across
 * hibernations.
 *
 * State is keyed weakly off the actor's `ctx`, which lives exactly as long as
 * the incarnation: a fresh isolate gets a fresh `ctx`, adopts the persisted
 * counter, and bumps it once. The embedder reads `generation(ctx)` wherever it
 * needs the incarnation number — one source of truth instead of mirrored host
 * fields.
 */

import { errorText } from '@nimbus-sh/core/_shared/error-text.js';

/**
 * Storage key for the isolate-generation counter (cold-start +
 * post-hibernation wake; one increment per fresh isolate).
 *
 * The VALUE is live production DO storage ('w9_isolate_gen') and must never
 * change — renaming a storage key is a migration, and orphaned rows are the
 * least of what it breaks.
 */
export const GENERATION_KEY = 'w9_isolate_gen';

/** The storage the generation counter persists through. */
export interface GenerationStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** The hosting actor's context, as the generation clock reads it. */
export interface GenerationContext {
  storage: GenerationStorage;
}

interface GenerationState {
  value: number;
  adopted: boolean;
  /** Deferred reconciliation tasks, drained by {@link runColdStart}. */
  coldStart: Array<() => Promise<unknown>>;
  /** Serializes drains so two callers never run one task twice. */
  coldStartChain: Promise<void>;
}

const states = new WeakMap<object, GenerationState>();

function stateOf(ctx: object): GenerationState {
  let state = states.get(ctx);
  if (!state) {
    state = { value: 0, adopted: false, coldStart: [], coldStartChain: Promise.resolve() };
    states.set(ctx, state);
  }
  return state;
}

/** This incarnation's generation. Zero until {@link adoptGeneration} ran. */
export function generation(ctx: object): number {
  return states.get(ctx)?.value ?? 0;
}

/** Increment + persist the generation counter once per fresh isolate. */
export async function adoptGeneration(ctx: GenerationContext): Promise<void> {
  const state = stateOf(ctx);
  if (state.adopted) return;
  state.adopted = true;
  try {
    const prev = (await ctx.storage.get(GENERATION_KEY)) as number | undefined;
    // Adopt the persisted truth first, and adopt the bump only after the
    // put resolves. An unpersisted `next` would be re-read as `prev` by the
    // NEXT boot and re-issued — two instances sharing one generation is
    // exactly the pid-aliasing this counter exists to prevent. Running on
    // the previous persisted generation is the lesser lapse, and the
    // put-failure case is replica-only in practice (replicas never spawn).
    //
    // What holds the guarantee is the output gate, not this await: measured,
    // the block body resolves in 0 ms even with a confirmed put, because
    // `await storage.put()` returns before durability. The gate is what
    // keeps a pid from generation N from escaping before N is durable, which
    // is why marking this put `allowUnconfirmed` is not a free speedup — see
    // scratchpad/coldstart-s1.md.
    state.value = typeof prev === 'number' ? prev : 0;
    const next = state.value + 1;
    await ctx.storage.put(GENERATION_KEY, next);
    state.value = next;
  } catch (e) {
    console.warn('[nimbus/W9] generation bump failed:', errorText(e));
  }
}

/**
 * Take on a generation without persisting it, and clear the adopted guard so
 * a later {@link adoptGeneration} re-derives from storage. The
 * destroy-and-recreate path uses this: it wipes storage, re-persists the
 * pre-destroy counter, and runs the rest of this incarnation on the successor
 * generation the next boot will derive.
 */
export function assumeGeneration(ctx: object, value: number): void {
  const state = stateOf(ctx);
  state.value = value;
  state.adopted = false;
}

/**
 * Queue deferred async reconciliation for this incarnation.
 *
 * The task runs on the first {@link runColdStart} after registration — a turn
 * the embedder already owns, NEVER the constructor's init gate. Awaiting
 * recovery on the gate path is the trap this helper exists to avoid: the gate
 * blocks every request to the object, and reconciliation wants a filesystem
 * and a terminal that only a later turn has.
 */
export function onColdStart(ctx: object, task: () => Promise<unknown>): void {
  stateOf(ctx).coldStart.push(task);
}

/**
 * Drain the queued cold-start tasks, serialized, each awaited so the turn
 * that runs them pays for them. Idempotent between registrations: a drained
 * queue is a cheap no-op, and a task registered after a drain runs on the
 * next call.
 */
export function runColdStart(ctx: object): Promise<void> {
  const state = stateOf(ctx);
  if (state.coldStart.length === 0) return state.coldStartChain;
  const tasks = state.coldStart;
  state.coldStart = [];
  const chained = state.coldStartChain.then(async () => {
    for (const task of tasks) {
      await task();
    }
  });
  state.coldStartChain = chained.catch(() => {});
  return chained;
}
