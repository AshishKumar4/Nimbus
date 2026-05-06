#!/usr/bin/env bun
/**
 * X.5-peer-gap P1 — Confirm defu's shim shape.
 *
 * Hypothesis: defu's `main` field points at a thin CJS shim
 * (`lib/defu.cjs`) that does `require("../dist/defu.cjs")`. The
 * `dist/defu.cjs` IS in the registry tarball (so it lands on VFS-disk
 * during install) but the prefetch bundler's `greedyAddMainEntries`
 * adds `lib/defu.cjs` WITHOUT recursing into its requires, and the
 * walker reaches `defu/dist/defu.mjs` via nuxt's ESM `import` (not
 * `lib/defu.cjs` via CJS require), so `dist/defu.cjs` never enters
 * `__vfsBundle`. At runtime, CJS `require('defu')` resolves through
 * exports.require to `lib/defu.cjs`, which then `require('../dist/defu.cjs')`
 * → `__fileExists` (bundle-only) returns false → Cannot find module.
 *
 * Read-only probe: fetches the live tarball + asserts file presence
 * + entry shape. No src/ writes.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/x5peer-gap-defu-shim';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const r1 = spawnSync('curl', ['-sL', 'https://registry.npmjs.org/defu/-/defu-6.1.7.tgz', '-o', `${TMP}/d.tgz`]);
if (r1.status !== 0) { console.error('FETCH FAIL'); process.exit(1); }
const r2 = spawnSync('tar', ['-xzf', `${TMP}/d.tgz`, '-C', TMP]);
if (r2.status !== 0) { console.error('EXTRACT FAIL'); process.exit(1); }

const pkgPath = `${TMP}/package`;
const meta = JSON.parse(fs.readFileSync(`${pkgPath}/package.json`, 'utf8'));

console.log('=== defu@6.1.7 shape ===');
console.log('main:', meta.main);
console.log('module:', meta.module);
console.log('exports."."', JSON.stringify(meta.exports?.['.'], null, 2));
console.log();

const shim = fs.readFileSync(`${pkgPath}/lib/defu.cjs`, 'utf8');
console.log('=== lib/defu.cjs (CJS shim) ===');
console.log(shim);

const shimSize = fs.statSync(`${pkgPath}/lib/defu.cjs`).size;
const distSize = fs.statSync(`${pkgPath}/dist/defu.cjs`).size;
console.log(`=== sizes === lib/defu.cjs=${shimSize}B  dist/defu.cjs=${distSize}B`);
console.log();

const requiresUp = /require\s*\(\s*["']\.\.\/dist\/defu\.cjs["']/.test(shim);
const distExists = fs.existsSync(`${pkgPath}/dist/defu.cjs`);
console.log('--- assertions ---');
console.log(`  shim requires "../dist/defu.cjs"      : ${requiresUp}`);
console.log(`  dist/defu.cjs IS in tarball           : ${distExists}`);

// Resolve as CJS would: pkg.exports.require.default = ./lib/defu.cjs
const cjsTarget = meta.exports?.['.']?.require?.default;
console.log(`  exports.require.default               : ${cjsTarget}`);

// Verify: greedyAddMainEntries reads `meta.main`. Confirm it's the shim.
console.log(`  meta.main == ./lib/defu.cjs           : ${meta.main === './lib/defu.cjs'}`);

console.log();
console.log('=== conclusion ===');
console.log('greedyAddMainEntries (facet-manager.ts:644-728) will land');
console.log('lib/defu.cjs because meta.main = ./lib/defu.cjs. It does NOT');
console.log('parse-and-recurse the file\'s requires; it only adds the main');
console.log('entry + hash-chunk siblings + shared/ subdir. Since shim is in');
console.log('lib/ and target is in dist/, neither hash-chunk nor shared/ catches');
console.log('it. The require-walker (prefetchForRequire) DOES recurse but only');
console.log('reaches defu via nuxt\'s ESM `import` chain, landing dist/defu.mjs,');
console.log('not lib/defu.cjs. So dist/defu.cjs never enters __vfsBundle.');
