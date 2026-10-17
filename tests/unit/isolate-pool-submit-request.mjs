#!/usr/bin/env bun
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
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
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

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
  const pool = new IsolatePool(seen.env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0 });
  const ctl = new AbortController();
  const request = new Request('https://facet.internal/step', {
    method: 'POST',
    body: JSON.stringify({ line: 'print(1)' }),
    signal: ctl.signal,
  });
  const response = await pool.submitRequest(facetTaskSource("async (request) => Response.json(await request.json())"), request);
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
  const pool = new IsolatePool(seen.env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0 });
  const ctl = new AbortController();
  const pending = pool.submitRequest(
    facetTaskSource("async (request) => Response.json(await request.json())"),
    new Request('https://facet.internal/step', { method: 'POST', body: 'x', signal: ctl.signal }),
  );
  ctl.abort();
  await assert.rejects(pending, /aborted|abort/i, 'an aborted fetch rejects the dispatch');

  const firstId = seen.ids[0];
  seen.fetchImpl = async () => Response.json({ ok: true });
  await pool.submitRequest(
    facetTaskSource("async (request) => Response.json(await request.json())"),
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
  const pool = new IsolatePool(seen.env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, retries: 1 });
  const response = await pool.submitRequest(
    facetTaskSource("async (request) => Response.json(await request.json())"),
    new Request('https://facet.internal/step', { method: 'POST', body: 'x' }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2, 'one retry ran');
  assert.notEqual(seen.requests[1], seen.requests[0], 'the retry got a clone, not the spent Request');
}

// ── 4. A consumed Request is refused before any dispatch ────────────────────
{
  const seen = makeLoader();
  const pool = new IsolatePool(seen.env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0 });
  const request = new Request('https://facet.internal/step', { method: 'POST', body: 'x' });
  await request.text();
  await assert.rejects(
    pool.submitRequest(facetTaskSource("async (request) => Response.json(await request.json())"), request),
    /already consumed/,
    'a spent body cannot be re-issued — refuse loudly',
  );
  assert.equal(seen.requests.length, 0, 'nothing was dispatched');
}

// ── 5. The generated entrypoint converts what the task did ──────────────────
// The loader runs the module the pool generated: it builds the config the
// pool hands it, imports that module and calls its default class.
function runningLoader() {
  const state = { ids: [], dispatches: 0 };
  state.env = {
    LOADER: {
      get(id, config) {
        state.ids.push(id);
        const entry = (async () => {
          const { mainModule, modules, env } = await config();
          const { default: Entry } = await importModuleSet(modules, mainModule);
          return new Entry({}, env);
        })();
        return {
          getEntrypoint() {
            return {
              async fetch(request) { state.dispatches++; return (await entry).fetch(request); },
              async execute(...args) { state.dispatches++; return (await entry).execute(...args); },
            };
          },
        };
      },
    },
  };
  return state;
}
{
  const loader = runningLoader();
  const pool = new IsolatePool(loader.env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, retries: 1 });
  const post = () => new Request('https://facet.internal/step', { method: 'POST', body: '{"n":2}' });

  // A task that throws answers 500 with its message, once: a guest failure is not retried.
  const thrown = await pool.submitRequest(facetTaskSource("async () => { throw new Error('guest-thrown-token'); }"), post());
  assert.equal(thrown.status, 500);
  assert.deepEqual(await thrown.json(), { __nimbusFacetError: 'guest-thrown-token' });
  assert.equal(loader.dispatches, 1, 'a guest failure is an answer, not a transport fault to retry');
  const raw = await pool.submitRequest(facetTaskSource("async () => { throw 'guest-raw-token'; }"), post());
  assert.equal(raw.status, 500);
  assert.deepEqual(await raw.json(), { __nimbusFacetError: 'guest-raw-token' });

  // A Response passes through as the task made it; any other value is its JSON, undefined as null.
  const made = await pool.submitRequest(facetTaskSource("async (request) => new Response(`made ${(await request.json()).n}`, { status: 201, headers: { 'x-made': 'yes' } })"), post());
  assert.equal(made.status, 201);
  assert.equal(made.headers.get('x-made'), 'yes');
  assert.equal(await made.text(), 'made 2');
  const value = await pool.submitRequest(facetTaskSource("async (request) => ({ doubled: (await request.json()).n * 2 })"), post());
  assert.equal(value.status, 200);
  assert.deepEqual(await value.json(), { doubled: 4 });
  const nothing = await pool.submitRequest(facetTaskSource('async () => undefined'), post());
  assert.equal(nothing.status, 200);
  assert.equal(await nothing.json(), null);

  // The RPC path returns the task's own value, and its failure rejects.
  assert.deepEqual(await pool.submit(facetTaskSource('async (arg) => ({ got: arg })'), 7), { got: 7 });
  await assert.rejects(pool.submit(facetTaskSource("async () => { throw new Error('rpc-thrown-token'); }"), null), /rpc-thrown-token/);
  await pool.dispose();
}
{
  // A pool with bindings hands its env to the task, after the request or the argument.
  const loader = runningLoader();
  const pool = new IsolatePool(loader.env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, extraBindings: { MARK: 'bound-mark' } });
  const fetched = await pool.submitRequest(facetTaskSource('async (request, env) => ({ mark: env.MARK, body: await request.json() })'),
    new Request('https://facet.internal/step', { method: 'POST', body: '{"n":2}' }));
  assert.deepEqual(await fetched.json(), { mark: 'bound-mark', body: { n: 2 } });
  assert.deepEqual(await pool.submit(facetTaskSource('async (arg, env) => ({ arg, mark: env.MARK })'), 5), { arg: 5, mark: 'bound-mark' });
  await pool.dispose();
}

// ── A failed run of a process that writes says what it may have lost ──
// (unsettledEnd.) A one-shot facet acknowledges writes before the session
// answers them, and ones made since it last yielded never left it; one that
// dies or is killed loses them, and its error says so every time: the
// session cannot know whether there were any. Red before: the error said
// nothing of it.
{
  const { adoptCtxExports } = await import('../../packages/fabric/src/composition.ts');
  const { UNSETTLED_END_NOTE, unsettledNoteOf } = await import('../../packages/core/src/_shared/process-fs-client.ts');
  adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
  const dying = () => makeLoader({ fetchImpl: async () => { throw new Error('Worker exceeded memory limit.'); } });
  const request = () => new Request('https://facet.internal/run', { method: 'POST', body: '{}' });
  // A process that writes: its error says what may be lost.
  const writer = new IsolatePool(dying().env, { ...ctx, id: { toString: () => 'unsettled-test-do' } }, { network: ISOLATE_NETWORK, supervisorPid: 77, timeoutMs: 0 });
  const loud = await writer.submitRequest(facetTaskSource("async (request) => Response.json(await request.json())"), request()).catch((error) => error);
  assert.match(loud.message, /Worker exceeded memory limit/);
  assert.ok(loud.message.includes(UNSETTLED_END_NOTE), loud.message);
  assert.equal(unsettledNoteOf(loud), `${UNSETTLED_END_NOTE}\n`);
  // A pool bound to no process writes nothing: its error is the run's own.
  const pure = new IsolatePool(dying().env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0 });
  const quiet = await pure.submitRequest(facetTaskSource("async (request) => Response.json(await request.json())"), request()).catch((error) => error);
  assert.equal(quiet.message.includes(UNSETTLED_END_NOTE), false);
}

console.log('isolate-pool-submit-request: all checks passed');
