// W3.5 — run all probes (functional + regression + e2e)
//
// Usage:
//   bun audit/probes/w3.5/run-all.mjs                            # default: prod
//   BASE=http://localhost:8787 bun audit/probes/w3.5/run-all.mjs # local wrangler dev
//   bun audit/probes/w3.5/run-all.mjs --only=esm-in-bundle       # one
//   bun audit/probes/w3.5/run-all.mjs --skip-e2e                 # skip slow e2e
//
// Reports total/passed/failed/skipped, exits non-zero if any failure.
// Output captured to audit/probes/w3.5/_results/<probe>.out.txt and
// _SUMMARY.json.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, '_results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const onlyName = args.find(a => a.startsWith('--only='))?.split('=')[1];
const skipE2e = args.includes('--skip-e2e');
const skipFunctional = args.includes('--skip-functional');
const skipRegression = args.includes('--skip-regression');
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '1', 10);

const SUITES = [
  { dir: 'functional', skip: skipFunctional },
  { dir: 'regression', skip: skipRegression },
  { dir: 'e2e',        skip: skipE2e },
];

async function loadProbes() {
  const probes = [];
  for (const { dir, skip } of SUITES) {
    if (skip) continue;
    const dirPath = path.join(HERE, dir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.mjs')).sort();
    for (const file of files) {
      const name = file.replace(/\.mjs$/, '');
      if (onlyName && name !== onlyName) continue;
      probes.push({ suite: dir, name, file: path.join(dirPath, file) });
    }
  }
  return probes;
}

async function runOne(probe) {
  const t0 = Date.now();
  try {
    const mod = await import(probe.file);
    const fn = mod.default;
    if (typeof fn !== 'function') {
      return { ...probe, pass: false, message: 'no default export', elapsed: Date.now() - t0 };
    }
    const res = await fn();
    return { ...probe, pass: !!res?.pass, message: res?.message || '', elapsed: Date.now() - t0 };
  } catch (e) {
    return { ...probe, pass: false, message: 'EXCEPTION: ' + (e?.message || e), elapsed: Date.now() - t0 };
  }
}

async function runMany(probes, conc) {
  if (conc <= 1) {
    const results = [];
    for (const p of probes) {
      console.log(`[START ${p.suite}/${p.name}]`);
      const r = await runOne(p);
      console.log(`[${r.pass ? 'PASS' : 'FAIL'} ${p.suite}/${p.name}] ${r.elapsed}ms ${r.pass ? '' : '— ' + (r.message || '').slice(0, 200)}`);
      results.push(r);
    }
    return results;
  }
  let cursor = 0;
  const results = [];
  async function worker() {
    while (cursor < probes.length) {
      const idx = cursor++;
      const p = probes[idx];
      console.log(`[START ${p.suite}/${p.name}]`);
      const r = await runOne(p);
      console.log(`[${r.pass ? 'PASS' : 'FAIL'} ${p.suite}/${p.name}] ${r.elapsed}ms`);
      results[idx] = r;
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  return results;
}

async function main() {
  const base = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
  console.log(`W3.5 run-all — BASE=${base} concurrency=${concurrency}`);
  if (skipE2e) console.log('  --skip-e2e');
  if (skipFunctional) console.log('  --skip-functional');
  if (skipRegression) console.log('  --skip-regression');
  if (onlyName) console.log(`  --only=${onlyName}`);

  const probes = await loadProbes();
  console.log(`  loaded ${probes.length} probe(s)`);
  if (probes.length === 0) { console.log('No probes matched. Exit 0.'); process.exit(0); }

  const results = await runMany(probes, concurrency);
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  fs.writeFileSync(
    path.join(RESULTS_DIR, '_SUMMARY.json'),
    JSON.stringify({
      base,
      timestamp: new Date().toISOString(),
      total: results.length,
      passed,
      failed,
      results: results.map(({ suite, name, pass, message, elapsed }) => ({ suite, name, pass, message: pass ? '' : (message || '').slice(0, 500), elapsed })),
    }, null, 2),
  );

  console.log('');
  console.log('========================================');
  console.log('W3.5 run-all summary:');
  console.log(`  total:   ${results.length}`);
  console.log(`  passed:  ${passed}`);
  console.log(`  failed:  ${failed}`);
  console.log('========================================');
  if (failed > 0) {
    console.log('');
    console.log('Failed probes:');
    for (const r of results.filter(x => !x.pass)) {
      console.log(`  - ${r.suite}/${r.name} :: ${(r.message || '').slice(0, 200)}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
