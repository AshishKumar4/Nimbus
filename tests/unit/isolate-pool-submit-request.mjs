#!/usr/bin/env bun
// isolate-pool-submit-request — the pool's fetch transport is its one
// cancellable dispatch: the caller's Request (signal included) reaches
// entrypoint.fetch, an aborted signal bumps the slot generation so the
// next dispatch lands on a fresh interpreter, and retries re-issue an
// unconsumed clone rather than a spent Request.
//
// Why this exists: RPC execute() cannot be cancelled (measured against
// local workerd — a pending promise's Symbol.dispose does nothing), so
// Ctrl-C through a REPL needs the fetch path. These mocks stand in for
// the loader: they record which id and which Request each attempt saw.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';

const ctx = {
  id: { toString: () => 'submit-request-test-do' },
  waitUntil() {},
};

function makeLoader({ fetchImpl } = {}) {
  const state = {
    ids: [],
    requests: [],
    fetchImpl: fetchImpl ?? (async () => Response.json({ ok: true })),
  };
  state.env = {
    LOADER: {
      get(id) {
        state.ids.push(id);
        return {
          getEntrypoint() {
            return {
              async fetch(request) {
                state.requests.push(request);
                return state.fetchImpl(request);
              },
            };
          },
        };
      },
    },
  };
  return state;
}

// fn must serialize — toString() is the wire format, like every pool fn.
// The guest would run this serialized; the mock emulates its body so the
// caller-side contract (Request in, Response out) is what is under test.
const echoFn = async (request) => Response.json(await request.json());

// ── 1. The caller's Request reaches entrypoint.fetch via a clone, signal included ──
{
  const seen = makeLoader({
    fetchImpl: async (request) => Response.json(await request.json()),
  });
  const pool = new IsolatePool(seen.env, ctx, { omitSupervisor: true, timeoutMs: 0 });
  const ctl = new AbortController();
  const request = new Request('https://facet.internal/step', {
    method: 'POST',
    body: JSON.stringify({ line: 'print(1)' }),
    signal: ctl.signal,
  });
  const response = await pool.submitRequest(echoFn, request);
  assert.equal(response.status, 200);
  assert.deepEqual(seen.requests.length, 1, 'one fetch attempt');
  assert.notEqual(seen.requests[0], request,
    'every attempt fetches a clone — the caller\'s Request stays unconsumed for retries');
  assert.equal(seen.requests[0].url, request.url, 'the clone carries the same request');
  assert.equal(seen.requests[0].signal, request.signal, 'the clone follows the caller\'s signal');
  const body = await response.json();
  assert.deepEqual(body, { line: 'print(1)' });
  assert.equal(request.bodyUsed, false, 'the original Request is never consumed by the pool');
}
// ── 2. Abort bumps the slot generation: the next dispatch is a fresh id ─────
{
  const seen = makeLoader({
    fetchImpl: (request) =>
      new Promise((_, reject) => {
        // Both orderings are real: the signal may already be aborted when
        // fetch is invoked (queueMicrotask guard defers dispatch past the
        // caller's abort()), or abort mid-flight.
        if (request.signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        request.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const pool = new IsolatePool(seen.env, ctx, { omitSupervisor: true, timeoutMs: 0 });
  const ctl = new AbortController();
  const pending = pool.submitRequest(
    echoFn,
    new Request('https://facet.internal/step', { method: 'POST', body: 'x', signal: ctl.signal }),
  );
  ctl.abort();
  await assert.rejects(pending, /aborted|abort/i, 'an aborted fetch rejects the dispatch');

  const firstId = seen.ids[0];
  seen.fetchImpl = async () => Response.json({ ok: true });
  await pool.submitRequest(
    echoFn,
    new Request('https://facet.internal/step', { method: 'POST', body: 'x' }),
  );
  assert.notEqual(seen.ids[1], firstId,
    'the slot generation must bump after an abort — a fresh interpreter, not the abandoned heap');
  assert.match(seen.ids[1], /g1$/, 'generation 1 after the abort');
}

// ── 3. Retries re-issue an unconsumed clone with the SAME body bytes ────────
{
  let calls = 0;
  const seen = makeLoader({
    fetchImpl: async (request) => {
      calls += 1;
      // Consume the body on EVERY attempt — a retry must never inherit a
      // spent Request, and the clone must carry the original bytes.
      const text = await request.text();
      assert.equal(text, 'x', `attempt ${calls} received the full original body`);
      if (calls === 1) throw new Error('transient reset');
      return Response.json({ attempt: calls });
    },
  });
  const pool = new IsolatePool(seen.env, ctx, { omitSupervisor: true, timeoutMs: 0, retries: 1 });
  const response = await pool.submitRequest(
    echoFn,
    new Request('https://facet.internal/step', { method: 'POST', body: 'x' }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2, 'one retry ran');
  assert.notEqual(seen.requests[1], seen.requests[0], 'the retry got a clone, not the spent Request');
}

// ── 4. A consumed Request is refused before any dispatch ────────────────────
{
  const seen = makeLoader();
  const pool = new IsolatePool(seen.env, ctx, { omitSupervisor: true, timeoutMs: 0 });
  const request = new Request('https://facet.internal/step', { method: 'POST', body: 'x' });
  await request.text();
  await assert.rejects(
    pool.submitRequest(echoFn, request),
    /already consumed/,
    'a spent body cannot be re-issued — refuse loudly',
  );
  assert.equal(seen.requests.length, 0, 'nothing was dispatched');
}

// ── 5. A guest failure surfaces as a 500 response, not a transport abort ────
{
  const seen = makeLoader();
  const pool = new IsolatePool(seen.env, ctx, { omitSupervisor: true, timeoutMs: 0 });
  // The generated entrypoint wraps fn failures into a 500 — simulate it here
  // to pin the caller-side contract: 500s flow back as Responses, and the
  // adapter unwraps __nimbusFacetError.
  seen.fetchImpl = async () =>
    Response.json({ __nimbusFacetError: 'boom' }, { status: 500 });
  const response = await pool.submitRequest(
    echoFn,
    new Request('https://facet.internal/step', { method: 'POST', body: 'x' }),
  );
  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.__nimbusFacetError, 'boom');
}

// ── 6. The generated entrypoint class exposes fetch alongside execute ───────
{
  const { assembleLoaderWorkerModuleSource } = await import('../../packages/fabric/src/isolate-pool.ts');
  const source = assembleLoaderWorkerModuleSource({
    fnSource: 'async () => 1',
    hasBindings: false,
  });
  assert.match(source, /async fetch\(request\)/, 'the fetch entrypoint is generated');
  assert.match(source, /execute\(\.\.\.args\)/, 'the RPC entrypoint is unchanged');
  assert.match(source, /__nimbusFacetError/, 'fn failures wrap into a 500 payload');
}

console.log('isolate-pool-submit-request: all checks passed');
