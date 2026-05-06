#!/usr/bin/env bun
// X.5-NPQO P functional: __resolveFrom must accept literal `.` and `..`
// as relative-resolution aliases (CommonJS spec for require('.')).
//
// Pre-fix: literal `.` and `..` slip past the startsWith('./') guards and
// fall into the bare-spec branch, querying node_modules for a package
// literally named `.` — fails with "Cannot find module '.'".
//
// Post-fix: literal `.` is normalized to './' and literal `..` to '../'
// before the relative-guard check, so they flow into __resolveFile (which
// then probes index.js / package.json#main / extension lookup).
//
// Probe asserts:
//   1. __resolveFrom function source contains an `id === "."` normalization
//   2. __resolveFrom function source contains an `id === ".."` normalization
//   3. The normalization happens BEFORE the existing relative-guard if-block
//   4. The original startsWith('./') / startsWith('../') / startsWith('/')
//      guards are still present (regression sanity)

import { ok, group, summary } from '../../w6/_tap.mjs';
import { getShimSource, extractResolveFromFn } from './_eval-shims.mjs';

const src = getShimSource();
const fn = extractResolveFromFn(src);

group('__resolveFrom: function discoverable', () => {
  ok('__resolveFrom function source extracted',
    fn !== null && fn.length > 0,
    fn === null ? '__resolveFrom not found' : `len=${fn.length}`,
  );
});

group('X.5-P fix: literal "." / ".." normalization', () => {
  ok('handles literal "." (id === "." or equivalent)',
    /id\s*===\s*['"]\.['"]/.test(fn || ''),
  );
  ok('handles literal ".." (id === ".." or equivalent)',
    /id\s*===\s*['"]\.\.['"]/.test(fn || ''),
  );
  // The fix must intervene BEFORE the existing relative-guard if-block —
  // i.e. the `id === "."` check must appear before the EXECUTABLE
  // `startsWith("./")` check (not just the comment-text mention).
  // Strip JS comments before computing offsets to avoid false positives
  // from the X.5-P doc-comment which mentions startsWith() in prose.
  if (fn) {
    const stripped = (fn || '')
      .replace(/\/\/[^\n]*/g, '')          // line comments
      .replace(/\/\*[\s\S]*?\*\//g, '');   // block comments
    const dotEqIdx = stripped.search(/id\s*===\s*['"]\.['"]/);
    const startsWithRelIdx = stripped.indexOf('startsWith("./")');
    ok('"." / ".." normalization occurs before startsWith("./") guard',
      dotEqIdx >= 0 && startsWithRelIdx >= 0 && dotEqIdx < startsWithRelIdx,
      `dotEqIdx=${dotEqIdx} startsWithRelIdx=${startsWithRelIdx}`,
    );
  } else {
    ok('"." / ".." normalization occurs before startsWith("./") guard', false, 'fn null');
  }
});

group('regression: existing relative-guard branches still present', () => {
  ok('startsWith("./") guard still present',
    /startsWith\(['"]\.\/['"]\)/.test(fn || ''),
  );
  ok('startsWith("../") guard still present',
    /startsWith\(['"]\.\.\/['"]\)/.test(fn || ''),
  );
  ok('startsWith("/") absolute guard still present',
    /startsWith\(['"]\/['"]\)/.test(fn || ''),
  );
  ok('startsWith("#") imports-field branch still present',
    /startsWith\(['"]#['"]\)/.test(fn || ''),
  );
  ok('__resolveNodeModule bare-spec fallback still present',
    /__resolveNodeModule\(/.test(fn || ''),
  );
});

summary('p-parent-dir');
