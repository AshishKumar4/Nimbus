#!/usr/bin/env bun
// X.5-M3 functional probe #2: when globalThis.__currentModulePath is unset,
// the URL shim's null-base fallback REMAINS the X.5-M behavior:
// `new URL(rel, undefined)` produces "file:///<resolved-rel>" (i.e.,
// fallback base is "file:///"). This preserves all pre-X.5-M3 contracts
// for top-level user code, eval'd snippets, etc.
//
// Critical regression guard: do not break X.5-M's lenient null-base fix
// when there is no module-loading context.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';
import { loadWrappedURL } from './_eval-shims.mjs';

const loaded = loadWrappedURL();

if (loaded === null) {
  group('SKIP: M3 marker missing — RED state', () => {
    ok('FIX-NOT-APPLIED', false);
  });
  summary('f2-url-null-base-no-context');
}

const { wrapped, stub } = loaded;

group('no __currentModulePath: fallback is "file:///" (X.5-M behavior)', () => {
  stub.__currentModulePath = undefined;
  let inst;
  try { inst = new wrapped('foo/bar.txt', null); } catch {}
  ok('null base accepted', inst !== undefined);
  if (inst) {
    eq('href starts with file:///', inst.href.slice(0, 8), 'file:///');
    eq('href ends with foo/bar.txt', inst.href.endsWith('foo/bar.txt'), true);
  }
});

group('empty __currentModulePath: fallback is "file:///" (X.5-M behavior)', () => {
  stub.__currentModulePath = '';
  let inst;
  try { inst = new wrapped('foo/bar.txt', null); } catch {}
  ok('null base accepted with empty current path', inst !== undefined);
  if (inst) {
    eq('empty current path falls back to bare file:///',
      inst.href, 'file:///foo/bar.txt');
  }
});

group('non-string __currentModulePath: fallback is "file:///" defensive', () => {
  stub.__currentModulePath = 42; // bogus value
  let inst;
  try { inst = new wrapped('foo/bar.txt', undefined); } catch {}
  ok('non-string current path tolerated', inst !== undefined);
  if (inst) {
    eq('non-string current path falls back to bare file:///',
      inst.href, 'file:///foo/bar.txt');
  }
});

group('regression: input-is-absolute-URL still works without base', () => {
  stub.__currentModulePath = 'whatever';
  let inst;
  try { inst = new wrapped('https://example.com/x?q=1'); } catch {}
  ok('absolute URL still constructs', inst !== undefined);
  if (inst) {
    eq('hostname preserved', inst.hostname, 'example.com');
    // Critically: should NOT include the __currentModulePath path.
    ok('href is the absolute input',
      inst.href === 'https://example.com/x?q=1');
  }
});

group('regression: invalid URL with no base still throws', () => {
  stub.__currentModulePath = undefined;
  let didThrow = false;
  try { new wrapped('not://valid url'); }
  catch { didThrow = true; }
  ok('invalid URL throws', didThrow);
});

summary('f2-url-null-base-no-context');
