#!/usr/bin/env bun
// X5M-M3 functional: lenient URL constructor — `new URL("rel", null)` no longer
// throws.
//
// Vite (and other rolldown-bundled packages) emits at module top-level:
//   const FOO = new URL("../../../src/node/constants.ts", import.meta.url);
// where the rolldown-CJS polyfill for import.meta.url evaluates to literal
// `null` in the facet (no document, no location, polyfill doesn't reach
// __filename). workerd's URL constructor strict-rejects null base, throwing
// "Invalid URL string." at module top-level eval, breaking require('vite').
//
// The X.5-M (M-3) shim wraps globalThis.URL so that null/undefined base
// defaults to "file:///" — turning the throw into a successful construction
// (vite still fails deeper at fs.readFileSync(URL) — that's out of M-3 charter).
//
// This probe extracts the M-3 wrap IIFE and tests the resulting URL.

import { ok, eq, throws, group, summary } from '../../w6/_tap.mjs';
import { getShimSource, loadWrappedURL } from './_eval-shims.mjs';

const src = getShimSource();
const wrapped = loadWrappedURL();

group('M-3 wrap is present in shim source', () => {
  ok('marker comment "X.5-M (M-3)" present',
    src.includes('X.5-M (M-3): lenient URL constructor'),
  );
  ok('wrap IIFE assigns globalThis.URL = <Shim>',
    /globalThis\.URL\s*=\s*\w+\s*;/.test(src) && src.includes('X.5-M (M-3)'),
  );
  ok('__urlMod.URL is updated post-wrap',
    /__urlMod\.URL\s*=\s*globalThis\.URL/.test(src),
  );
  ok('loadWrappedURL extracted a URL constructor', wrapped !== null);
});

if (wrapped !== null) {
  group('lenient URL constructor accepts null base', () => {
    let inst;
    try { inst = new wrapped("foo/bar.txt", null); }
    catch (e) { /* fail recorded below */ }
    ok('new URL("foo/bar.txt", null) does not throw', inst !== undefined);
    if (inst) {
      ok('result is a URL instance', inst instanceof globalThis.URL);
      ok('href starts with file:///',
        typeof inst.href === 'string' && inst.href.startsWith('file:///'),
        inst.href);
    }
  });

  group('lenient URL constructor accepts undefined base', () => {
    let inst;
    try { inst = new wrapped("foo/bar.txt", undefined); }
    catch (e) { /* fail recorded below */ }
    ok('new URL("foo/bar.txt", undefined) does not throw', inst !== undefined);
  });

  group('regression: valid absolute URL still works', () => {
    let inst;
    try { inst = new wrapped("https://example.com/path?q=1"); }
    catch (e) {}
    ok('new URL("https://example.com/path?q=1") works', inst !== undefined);
    if (inst) eq('hostname is example.com', inst.hostname, 'example.com');
  });

  group('regression: relative + valid base still works', () => {
    let inst;
    try { inst = new wrapped("./sub/path", "https://base.com/dir/"); }
    catch (e) {}
    ok('relative + valid base produces correct URL', inst !== undefined);
    if (inst) eq('href is base+rel', inst.href, 'https://base.com/dir/sub/path');
  });

  group('regression: invalid input still throws', () => {
    // Wording differs across runtimes (Bun: "cannot be parsed as a URL.",
    // workerd: "Invalid URL string."); both DO throw — that's the contract.
    let didThrow = false;
    try { new wrapped("not://valid url"); }
    catch { didThrow = true; }
    ok('new URL("not://valid url") with no base throws', didThrow);
  });

  group('regression: instanceof URL preserved', () => {
    const u = new wrapped("https://example.com");
    ok('wrapped URL instance is instanceof globalThis.URL',
      u instanceof globalThis.URL);
  });

  group('regression: static URL methods passthrough', () => {
    ok('URL.canParse exists on wrapper', typeof wrapped.canParse === 'function');
    if (typeof wrapped.canParse === 'function') {
      ok('URL.canParse("https://x") === true', wrapped.canParse('https://x'));
    }
  });
} else {
  // wrapped is null = pre-fix red state. Emit clear red signal.
  group('SKIP: M-3 wrap not yet present in source — RED state', () => {
    ok('FIX-NOT-YET-APPLIED: M-3 must add lenient URL guard', false);
  });
}

summary('m3-url-lenient-null-base');
