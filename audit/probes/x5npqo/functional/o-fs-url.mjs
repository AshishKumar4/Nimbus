#!/usr/bin/env bun
// X.5-NPQO O functional: fs `_resolve` must coerce `file://`-prefixed
// strings AND URL instances into POSIX paths before the existing
// `startsWith("/")` absolute-guard.
//
// Pre-fix: `String(p)` produces `"file:///package.json"`, which fails
// `startsWith("/")` and gets misrouted via path.resolve(cwd, …) →
// corrupt path → ENOENT at readFileSync.
//
// Post-fix: prepend a `file://` strip + URL-instance duck-type so
// `new URL('file:///package.json')` and `'file:///package.json'` both
// flow into the absolute-path branch.
//
// Probe asserts:
//   1. fs._resolve function source contains a `file://` strip
//   2. fs._resolve handles URL instance via duck-type (protocol === 'file:')
//   3. The fix happens BEFORE the existing startsWith("/") check
//   4. The original cwd-fallback path.resolve still present (regression sanity)

import { ok, group, summary } from '../../w6/_tap.mjs';
import { getShimSource, extractFsResolveFn } from './_eval-shims.mjs';

const src = getShimSource();
const fn = extractFsResolveFn(src);

group('fs._resolve: function discoverable', () => {
  ok('fs._resolve function source extracted',
    fn !== null && fn.length > 0,
    fn === null ? '_resolve(p) not found' : `len=${fn.length}`,
  );
});

group('X.5-O fix: file:// prefix strip', () => {
  ok('fs._resolve strips "file://" prefix',
    /file:\/\//.test(fn || ''),
    `_resolve does not mention file://`,
  );
  // The strip uses .slice(7) (length of "file://") to drop the prefix.
  ok('fs._resolve uses slice(7) to drop "file://" prefix',
    /\.slice\(7\)/.test(fn || ''),
  );
});

group('X.5-O fix: URL instance handling', () => {
  // We accept either:
  //   (a) duck-type: p && typeof p === 'object' && p.protocol === 'file:'
  //   (b) explicit instanceof URL check
  // The plan favors (a) because URL may not be in scope for all facets.
  ok('fs._resolve checks URL instance / protocol === "file:"',
    /protocol\s*===?\s*['"]file:['"]/.test(fn || '')
      || /instanceof\s+URL\b/.test(fn || ''),
  );
});

group('X.5-O fix: ordering — strip happens before "/" guard', () => {
  if (fn) {
    const fileStripIdx = fn.search(/file:\/\//);
    const slashGuardIdx = fn.search(/startsWith\(["']\/["']\)/);
    ok('file:// strip occurs before startsWith("/") absolute guard',
      fileStripIdx >= 0 && slashGuardIdx >= 0 && fileStripIdx < slashGuardIdx,
      `fileStripIdx=${fileStripIdx} slashGuardIdx=${slashGuardIdx}`,
    );
  } else {
    ok('file:// strip occurs before startsWith("/") absolute guard', false, 'fn null');
  }
});

group('regression: existing _resolve branches still present', () => {
  ok('startsWith("/") absolute branch still present',
    /startsWith\(['"]\/['"]\)/.test(fn || ''),
  );
  ok('cwd-fallback path.resolve(…) still present',
    /__pathMod\.resolve\(/.test(fn || ''),
  );
  ok('__pathMod.normalize for absolute paths still present',
    /__pathMod\.normalize\(/.test(fn || ''),
  );
});

summary('o-fs-url');
