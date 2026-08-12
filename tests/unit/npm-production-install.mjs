#!/usr/bin/env bun
/**
 * `--production` / `--omit=dev` actually omits devDependencies.
 *
 * A real installer stopped on
 *
 *     bun install --frozen-lockfile
 *     → npm install rejected: puppeteer — Bundled Chromium binary (~150 MB).
 *
 * from a *devDependency* of the root package. REFUSING IS CORRECT and stays
 * correct: a sandbox cannot execute a bundled Chromium, and downloading 150 MB
 * to fail later is the same dishonesty as answering `uname -m` with an
 * architecture whose binaries cannot run — the whole point of answering `wasm`
 * is that arch-keyed downloads fail at resolution instead.
 *
 * The defect is that the door out was painted on. Both npm and bun honour
 * `--production`/`--omit=dev`, the installer already took a `production`
 * option, and `omit` was already in the argument spec — but nothing ever read
 * the value, so the flag parsed and did NOTHING. That is the same category as
 * a `find` predicate that is accepted and ignored: the caller said what they
 * wanted, and the tool quietly did something else.
 *
 * Flag spellings measured against bun 1.3.1 (`-p, --production`,
 * `--omit=<val>`) and npm 10 (`--omit <val>`, repeatable).
 */

import assert from 'node:assert/strict';
import { parseNpmInstallInvocation } from '../../packages/worker/src/npm/install-args.ts';
import {
  formatRejectError,
  lookupReject,
} from '../../packages/worker/src/facets/wasm-swap-registry.ts';

// ── The flag reaches the installer ────────────────────────────────────────
for (const [args, production] of [
  [[], false],
  [['--production'], true],
  [['-p'], true],
  [['--omit=dev'], true],
  [['--omit', 'dev'], true],
  [['--omit=optional'], false],
  [['--omit=peer'], false],
  // npm allows the flag more than once; a generic parser keeps only the last
  // value, which would miss the one spelling that matters.
  [['--omit=optional', '--omit=dev'], true],
  [['--omit=dev', '--omit=optional'], true],
  [['--frozen-lockfile'], false],
  // `-P` is npm's --save-prod, not --production. The short map is
  // case-sensitive and both tools' spellings must land where they belong.
  [['-P'], false],
  [['--', '--omit=dev'], false],
]) {
  assert.equal(
    parseNpmInstallInvocation(args).production,
    production,
    `production for ${JSON.stringify(args)}`,
  );
}

// Everything the invocation already carried still parses.
{
  const parsed = parseNpmInstallInvocation(['-g', '--prefix', '/usr/local', 'react', '--production']);
  assert.equal(parsed.global, true);
  assert.equal(parsed.prefix, '/usr/local');
  assert.deepEqual(parsed.packages, ['react']);
  assert.equal(parsed.production, true);
}

// ── The refusal names the package and the way past it ─────────────────────
{
  const puppeteer = lookupReject('puppeteer');
  assert.ok(puppeteer, 'puppeteer is refused by the registry');
  assert.match(puppeteer.reason, /Chromium/, 'the refusal says what it is refusing');

  const asDevDep = formatRejectError([puppeteer], new Set(['puppeteer']));
  assert.match(asDevDep, /puppeteer/);
  assert.match(asDevDep, /devDependency/, 'the caller is told nothing they run needs it');
  assert.match(asDevDep, /--omit=dev/, 'and told the flag that installs the rest');

  // A runtime dependency has no such way out, and must not be offered one.
  const asRuntimeDep = formatRejectError([puppeteer], new Set());
  assert.doesNotMatch(asRuntimeDep, /--omit=dev/, 'no false escape for a real dependency');
  assert.doesNotMatch(asRuntimeDep, /devDependency/);
  assert.match(asRuntimeDep, /puppeteer/);

  // A mixed set is not all-dev, so the footer stays off.
  const nodePty = lookupReject('node-pty');
  assert.ok(nodePty);
  const mixed = formatRejectError([puppeteer, nodePty], new Set(['puppeteer']));
  assert.doesNotMatch(mixed, /--omit=dev/, 'the flag only helps when every reject is dev-only');
}

console.log('npm-production-install: ok');
