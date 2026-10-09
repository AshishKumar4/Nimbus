#!/usr/bin/env bun
// Which npm-bin invocations stay resident.
//
// Only the keyed long-running facet exposes a route stub that
// PortRegistry.routeRequest can re-resolve in a later request, so this
// decision is what makes a bound port reachable at all. A server sent down
// the one-shot path holds until the facet lifetime expires and then reports
// the limit it hit — live-observed as `astro preview` sitting for 27s and
// exiting 1 with "reached the 30s facet lifetime limit", while
// /s/<sid>/port/4321/ answered 502.
//
// `preview` used to sit in the one-shot exclusion beside `build`. It does not
// belong there: it binds a port and serves the built output, exactly as `dev`
// binds one and serves the source.

import assert from 'node:assert/strict';
import { looksLongRunningNpmBin } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';

// ── serving subcommands stay resident ───────────────────────────────────────
// `preview` is a serving verb wherever it exists, so it is pinned across every
// server-shaped bin rather than for one of them.
for (const bin of ['astro', 'nuxt', 'remix', 'next', 'vite']) {
  for (const argv of [[], ['dev'], ['preview'], ['preview', '--port', '4321']]) {
    assert.equal(
      looksLongRunningNpmBin(bin, argv), true,
      `${bin} ${argv.join(' ')} serves and must be routed long-running`,
    );
  }
}

// ── the subcommand that ends ────────────────────────────────────────────────
// `build` produces an artifact and exits. Classifying it resident is not a
// harmless over-approximation: a long-running bin that exits 0 is never
// reaped, so it stays `running` in `ps` for the life of the session.
for (const bin of ['astro', 'nuxt', 'remix', 'vite']) {
  assert.equal(
    looksLongRunningNpmBin(bin, ['build']), false,
    `${bin} build exits and must stay one-shot`,
  );
}

// ── queries answer and exit ─────────────────────────────────────────────────
for (const arg of ['--help', '-h', 'help', '--version', '-v', 'version']) {
  assert.equal(
    looksLongRunningNpmBin('astro', [arg]), false,
    `astro ${arg} is a query, not a server`,
  );
  assert.equal(
    looksLongRunningNpmBin('astro', ['preview', arg]), false,
    `astro preview ${arg} is a query, not a server`,
  );
}

// ── bins outside the known-server set ───────────────────────────────────────
// They are judged only by flags that ask for residency, so an ordinary CLI
// invocation cannot become a ghost process.
assert.equal(looksLongRunningNpmBin('tsc', ['--noEmit']), false);
assert.equal(looksLongRunningNpmBin('tsc', ['--watch']), true);
assert.equal(looksLongRunningNpmBin('some-cli', ['preview']), false,
  'an unknown bin is not promoted by a subcommand name alone');

console.log('npm-bin-long-running-classification: OK');
