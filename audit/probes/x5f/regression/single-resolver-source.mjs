// X.5-F regression — exactly ONE TypeScript file declares
// `function resolveExports`. Asserts the X.5-F build phase didn't
// introduce a 2nd impl. Per the dispatch prompt:
//
//   "Single resolver path verified: `grep -rln 'function resolveExports' src/`
//    returns ONE file"
//
// Caveat: the live grep may also match string-literal occurrences inside
// generated bundle stubs (e.g. real-vite-bundle.generated.ts which embeds
// vite client mjs). We discriminate by reading each match and checking
// for an actual TypeScript function declaration at top-of-file scope.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'single-resolver-source.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F single-resolver-source regression probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const SRC = path.resolve(HERE, '../../../../src');

// 1. List every file under src/ that contains 'function resolveExports'.
let matches;
try {
  matches = execSync(`grep -rln 'function resolveExports' ${JSON.stringify(SRC)}`, {
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
} catch (e) {
  // grep returns non-zero when no matches; treat as empty
  matches = [];
}
log('grep matches: ' + JSON.stringify(matches));

// 2. For each match, distinguish between
//    (a) a top-level TypeScript `export function resolveExports(` decl,
//    (b) an embedded JS string emission (getExportsResolverJS), or
//    (c) a string-literal artefact inside a .generated.ts.
const realImpls = [];
for (const f of matches) {
  const c = fs.readFileSync(f, 'utf8');
  // Real implementation = "export function resolveExports(" at line start
  // (allowing for indentation) AND not inside a backtick string.
  // We approximate by grepping for the export-function form, then
  // confirm it's BEFORE any `getExportsResolverJS` template literal.
  const hasExportDecl = /^\s*export\s+function\s+resolveExports\s*\(/m.test(c);
  if (hasExportDecl) {
    // Make sure it's not inside a template literal — find the line.
    const lines = c.split('\n');
    const lineIdx = lines.findIndex(L => /^\s*export\s+function\s+resolveExports\s*\(/.test(L));
    // Count unmatched backticks before that line. If even count, we're in
    // module body. If odd, we're inside a template literal.
    const before = lines.slice(0, lineIdx).join('\n');
    const tickCount = (before.match(/`/g) || []).length;
    if (tickCount % 2 === 0) {
      realImpls.push(f);
    } else {
      log('  ' + f + ': match is inside a backtick template — not a real impl');
    }
  } else {
    log('  ' + f + ': has the substring but no export-function declaration');
  }
}

log('real TS impls: ' + JSON.stringify(realImpls));
const SHARED = path.resolve(SRC, '_shared/exports-resolver.ts');
const onlyOne = realImpls.length === 1;
const isShared = realImpls[0] === SHARED;

log('exactly-one-impl:                ' + (onlyOne ? 'PASS' : 'FAIL'));
log('impl is _shared/exports-resolver.ts: ' + (isShared ? 'PASS' : 'FAIL'));

const ok = onlyOne && isShared;
log('OVERALL: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
