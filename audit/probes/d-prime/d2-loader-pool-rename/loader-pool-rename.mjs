// Phase 4 D'.2 functional probe — NimbusFacetPool → NimbusLoaderPool
// rename sweep is complete.
//
// Acceptance bar:
//   1. grep -rn "NimbusFacetPool" src/ returns ZERO hits.
//   2. grep -rn "NimbusFacetPoolOptions" src/ returns ZERO hits.
//   3. The new class name `NimbusLoaderPool` is exported from
//      src/parallel/index.ts (or wherever it lives post-rename).
//   4. The same module exports `NimbusLoaderPoolOptions` (or the
//      type-aliased name).
//   5. tsc baseline preserved (2 errors, both unrelated).
//
// Architectural intent: the pre-Phase-4 name "NimbusFacetPool" is
// misleading — that class is genuinely a Worker Loader pool (uses
// env.LOADER.get/load), not a DO Facet pool. The terminology
// collision with the platform's actual ctx.facets primitive caused
// repeated confusion in research/dossier docs (see
// audit/sections/PROD-RESET-RESEARCH-DOSSIER-DELTA.md §R3.1).
// D'.2 fixes the name; the implementation is unchanged.
//
// Pre-build (RED): grep finds 100+ occurrences across src/ and
// audit/. Post-build (GREEN): src/ has 0 occurrences; audit/ retains
// historical references for narrative continuity.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');  // worktree root
const ARTIFACT = path.join(HERE, 'loader-pool-rename.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

function grepCount(pattern, dir) {
  // -r recursive, -c per-file count; sum to total. --include patterns
  // restrict to .ts files (avoid generated bundles + node_modules).
  try {
    const out = execSync(
      `grep -rn --include="*.ts" "${pattern}" ${dir} 2>/dev/null || true`,
      { encoding: 'utf8', cwd: ROOT },
    );
    if (!out.trim()) return { total: 0, lines: [] };
    const lines = out.trim().split('\n');
    return { total: lines.length, lines };
  } catch (e) {
    return { total: 0, lines: [] };
  }
}

async function main() {
  log("==== D'.2 loader-pool-rename probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('ROOT: ' + ROOT);

  // ── Stage 1: src/ should have zero hits ─────────────────────────────
  const srcHits = grepCount('NimbusFacetPool', 'src');
  log(`stage 1: NimbusFacetPool hits in src/ = ${srcHits.total}`);
  if (srcHits.total === 0) {
    pass('grep -rn "NimbusFacetPool" src/ → 0 hits (rename complete)');
  } else {
    fail(`${srcHits.total} hits in src/:`);
    for (const line of srcHits.lines.slice(0, 10)) {
      log('  ' + line);
    }
    if (srcHits.lines.length > 10) log('  ... (+' + (srcHits.lines.length - 10) + ' more)');
  }

  const optHits = grepCount('NimbusFacetPoolOptions', 'src');
  log(`stage 1: NimbusFacetPoolOptions hits in src/ = ${optHits.total}`);
  if (optHits.total === 0) {
    pass('grep -rn "NimbusFacetPoolOptions" src/ → 0 hits');
  } else {
    fail(`${optHits.total} hits in src/`);
  }

  // ── Stage 2: new name is present ────────────────────────────────────
  const newClassHits = grepCount('NimbusLoaderPool', 'src');
  log(`stage 2: NimbusLoaderPool hits in src/ = ${newClassHits.total}`);
  if (newClassHits.total > 0) {
    pass(`new class name 'NimbusLoaderPool' present (${newClassHits.total} hits)`);
  } else {
    fail("NimbusLoaderPool not found in src/ — rename didn't actually rename");
  }

  // Verify the class is exported from src/parallel/index.ts (or
  // whatever the post-rename re-export module is).
  const indexPath = path.join(ROOT, 'src/parallel/index.ts');
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (/export\s+\{[^}]*NimbusLoaderPool[^}]*\}/.test(content)) {
      pass('src/parallel/index.ts exports NimbusLoaderPool');
    } else {
      fail('src/parallel/index.ts does NOT export NimbusLoaderPool');
    }
    // The old name should NOT be re-exported (clean break — not a
    // transitional alias, per the user-stated D'.2 acceptance bar).
    if (/export\s+\{[^}]*NimbusFacetPool[^}]*\}/.test(content)) {
      fail("src/parallel/index.ts still exports NimbusFacetPool — rename not clean");
    } else {
      pass('src/parallel/index.ts does NOT export NimbusFacetPool (clean break)');
    }
  } else {
    log('  note: src/parallel/index.ts not found — rename may have moved the file');
  }

  // ── Stage 3: tsc baseline preserved ─────────────────────────────────
  // Run tsc and assert the error set is exactly the 2 pre-existing
  // ones. A new error post-rename means we missed an import site.
  let tscErrors = '';
  try {
    execSync('bun x tsc --noEmit', { encoding: 'utf8', cwd: ROOT, stdio: 'pipe' });
    tscErrors = '';
    pass('tsc clean');
  } catch (e) {
    tscErrors = (e?.stdout || '') + (e?.stderr || '');
    const errLines = tscErrors.split('\n').filter(l => /error TS\d+/.test(l));
    log(`stage 3: tsc errors = ${errLines.length}`);
    for (const l of errLines.slice(0, 10)) log('  ' + l);
    if (errLines.length === 2) {
      // Check the 2 are the known baseline.
      const haveEsbuildErr = errLines.some(l => l.includes('esbuild-wasm/esbuild.wasm'));
      const haveSqliteVfsErr = errLines.some(l => l.includes('SqliteVFSProvider'));
      if (haveEsbuildErr && haveSqliteVfsErr) {
        pass('tsc errors = 2 baseline only (esbuild-wasm.wasm + SqliteVFSProvider)');
      } else {
        fail('tsc has 2 errors but they are NOT the known baseline');
      }
    } else {
      fail(`tsc error count = ${errLines.length} (expected 2 baseline)`);
    }
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
