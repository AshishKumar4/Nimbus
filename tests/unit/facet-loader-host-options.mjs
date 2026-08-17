#!/usr/bin/env bun
// facet-loader-host-options — the port's spec, as the loader pool reads it.
//
// `loaderFacetHost` is a rename and nothing else, which is exactly why it needs
// a test: every runtime that used to construct a NimbusLoaderPool by hand now
// states a FacetSpec instead, and a rename that lands one option in the wrong
// place is invisible until production behaves differently.
//
// Two mappings carry real consequences, and both are asserted here against
// what the pool actually built rather than against the adapter's source:
//
//   syscalls → omitSupervisor + supervisorPid. The supervisor derives the
//     WRITE credential from the pid, so a facet handed the capability without
//     one reads the session and silently writes nowhere. Ruby and CPython
//     depend on this being the invoking process's pid.
//
//   reuse → cacheScope. `session` (the default) bakes the owning DO id into
//     the loader cache key so a warm isolate can never answer for another
//     tenant. `global` is what lets clang's 31 MiB of compiled compiler stay
//     warm across sessions, and it is only safe because that facet holds no
//     supervisor and keeps nothing between calls.

import assert from 'node:assert/strict';

import { loaderFacetHost } from '../../packages/worker/src/runtime/facet-loader-host.ts';
import { setCtxExports, setSupervisorEntrypointName } from '../../packages/fabric/src/ctx-exports.ts';

// The pool mints its SUPERVISOR through ctx.exports; without one it degrades
// to no binding at all, which would make the pid assertion below vacuous.
setSupervisorEntrypointName('SupervisorRPC');
setCtxExports({ SupervisorRPC: (options) => ({ supervisorProps: options.props }) });

const DO_ID = 'session-do-id-0123456789';

function harness() {
  const dispatched = [];
  const env = {
    LOADER: {
      get(id, build) {
        dispatched.push({ id, code: build() });
        return {
          getEntrypoint: () => ({ execute: async () => ({ ok: true }) }),
        };
      },
    },
  };
  return { env, ctx: { id: { toString: () => DO_ID }, waitUntil() {} }, dispatched };
}

const facetFn = async function probeFacetCall() { return { ok: true }; };

// ── A facet that acts on the session, as ruby and cpython open one ──────────
{
  const { env, ctx, dispatched } = harness();
  const facet = loaderFacetHost(env, ctx).open({
    tag: 'probe-session',
    concurrency: 1,
    syscalls: { vfs: {}, pid: 4242 },
    preamble: 'const x = 1;',
  });
  await facet.submit(facetFn, {});

  assert.equal(dispatched.length, 1);
  const { id, code } = dispatched[0];
  assert.match(id, /^nfp:probe-session:session-do-i:/, 'the cache key is scoped to this session');
  assert.deepEqual((await code).env.SUPERVISOR.supervisorProps, { doId: DO_ID, pid: 4242 },
    'the capability is minted for the invoking process, not for pid 0');
  facet.dispose();
  console.log('  ok  syscalls become a supervisor bound to that pid, in a session-scoped slot');
}

// ── A sealed facet, as clang opens one ──────────────────────────────────────
{
  const { env, ctx, dispatched } = harness();
  const facet = loaderFacetHost(env, ctx).open({
    tag: 'probe-sealed',
    concurrency: 1,
    reuse: 'global',
    preamble: 'const x = 1;',
  });
  await facet.submit(facetFn, {});

  assert.equal(dispatched.length, 1);
  const { id, code } = dispatched[0];
  assert.match(id, /^nfp:probe-sealed:global:/, 'a sealed facet is warm for every tenant');
  assert.equal((await code).env, undefined, 'and holds no capability over any session');
  facet.dispose();
  console.log('  ok  reuse:global drops the session from the cache key, with no supervisor bound');
}

console.log('facet-loader-host-options: ok');
