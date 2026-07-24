#!/usr/bin/env bun
// git-network-facet-name-shim — regression guard for the esbuild-keepNames
// `__name` break that took down prod git clone
// ("Failed to load bundled isomorphic-git: __name is not defined").
//
// The git facet embeds the retry wrapper via `${createRetryingGitHttp.toString()}`.
// When wrangler/esbuild bundles the worker with keepNames, the wrapper's nested
// named arrows (`waitBeforeRetry`, `collectBody`) are wrapped as `__name(fn, "fn")`.
// At runtime `.toString()` returns that body WITHOUT the bundle's hoisted `__name`
// helper (which lives elsewhere in the bundle), so invoking the wrapper inside the
// git facet isolate — which has no `__name` binding — throws ReferenceError.
//
// The un-bundled unit tests never surface this (plain `.toString()` has no
// `__name(` wraps), so this test reproduces the keepNames transform faithfully:
// it esbuild-transforms the wrapper, takes the wrapped FUNCTION BODY via a second
// `.toString()` (mirroring the runtime embed, minus the hoisted helper), and
// proves (a) it breaks without the facet shim and (b) the facet shim defends it
// while retry behavior is preserved.

import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

import {
  assembleGitNetworkFacetSource,
  createRetryingGitHttp,
} from '../../packages/worker/src/git/network-facet.ts';

// The exact idempotent shim the facet template injects. Asserted byte-identical
// against the real assembled facet below, so this constant is not a drift risk.
const FACET_NAME_SHIM =
  'if (typeof globalThis.__name !== "function") {\n' +
  '  globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });\n' +
  '}';

// --- Part A: the real facet template carries the shim BEFORE the retry embed ---
const facet = assembleGitNetworkFacetSource();
assert.ok(facet.includes(FACET_NAME_SHIM),
  'assembled git facet is missing the idempotent globalThis.__name shim');
const shimIdx = facet.indexOf('globalThis.__name');
const embedIdx = facet.indexOf('createRetryingGitHttp(baseHttp');
assert.ok(embedIdx > 0, 'assembled git facet does not embed createRetryingGitHttp');
assert.ok(shimIdx > 0 && shimIdx < embedIdx,
  `__name shim (idx ${shimIdx}) must precede the createRetryingGitHttp embed (idx ${embedIdx})`);

// --- Reproduce the keepNames-wrapped runtime body of the retry wrapper ---
// esbuild.transform PREPENDS its own `var __name` helper, so the raw output is
// self-contained. We evaluate it once to obtain the wrapped function object, then
// take ITS `.toString()` — which is the body with bare `__name(` references and
// NO helper, exactly what the deployed worker embeds into the facet at runtime.
const transformed = await esbuild.transform(createRetryingGitHttp.toString(), {
  loader: 'js',
  keepNames: true,
  minify: false,
});
assert.ok(transformed.code.includes('__name('),
  'esbuild keepNames did not wrap the retry wrapper — test precondition invalid');

const wrappedFn = new Function(`${transformed.code}\nreturn createRetryingGitHttp;`)();
const wrappedBody = wrappedFn.toString();
assert.ok(wrappedBody.includes('__name('),
  'the wrapped retry BODY must still reference __name (the exact prod hazard)');
assert.ok(!/\b(var|const|let)\s+__name\b/.test(wrappedBody),
  'the wrapped body must NOT carry its own __name declaration (else the test is vacuous)');

function queuedHttp(outcomes) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const outcome = outcomes[calls.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

// --- Part B (RED): without the shim, the facet isolate has no __name ---
// Run BEFORE the shim ever defines globalThis.__name so the hazard is genuine.
assert.equal(typeof globalThis.__name, 'undefined',
  'globalThis.__name unexpectedly predefined — cannot prove the RED failure');
const unshielded = new Function(`${wrappedBody}\nreturn createRetryingGitHttp;`)();
await assert.rejects(
  async () => {
    const http = unshielded(queuedHttp([{ statusCode: 200 }]));
    await http.request({ method: 'GET', url: 'https://example.com/info/refs?service=git-upload-pack' });
  },
  /__name is not defined/,
  'expected the un-shielded wrapped body to throw "__name is not defined"',
);

// --- Part B (GREEN): the facet shim defines __name; retry still works ---
const shielded = new Function(`${FACET_NAME_SHIM}\n${wrappedBody}\nreturn createRetryingGitHttp;`)();
const transient = queuedHttp([{ statusCode: 522 }, { statusCode: 200 }]);
const res = await shielded(transient, { backoffMs: [1, 1], maxAttempts: 3 }).request({
  method: 'GET',
  url: 'https://example.com/project.git/info/refs?service=git-upload-pack',
});
assert.equal(res.statusCode, 200, 'shielded retry wrapper did not surface the retried 200');
assert.equal(transient.calls.length, 2, 'shielded retry wrapper did not retry the transient 522');
assert.equal(typeof globalThis.__name, 'function',
  'the facet shim should have defined globalThis.__name');

console.log('git-network-facet name shim: ok');
