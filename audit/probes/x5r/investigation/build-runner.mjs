// Compile node-shims.ts via esbuild and call generateShimsCode() to get the real string.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const result = await esbuild.build({
  entryPoints: ['/workspace/worktrees/x5r-events-class/src/node-shims.ts'],
  absWorkingDir: '/workspace/worktrees/x5r-events-class',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: [],
  write: false,
  logLevel: 'silent',
});
// Quick fallback: just import via dynamic import after writing a temp .mjs
writeFileSync('/tmp/_shims_bundle.mjs', result.outputFiles[0].text);
const m = await import('/tmp/_shims_bundle.mjs');
const shims = m.generateShimsCode();
console.log('SHIMS length:', shims.length, 'lines:', shims.split('\n').length);

// Build mock runner.js similarly
const fm = readFileSync('/workspace/worktrees/x5r-events-class/src/facet-manager.ts', 'utf8');
const tplBody = fm.match(/function generateFacetCode[^]*?return\s*`([^]*?)`;\s*\n\}/)[1];
// fill placeholders
const userCode = '/* USER */';
const safeCode = JSON.stringify(userCode);
const safeBundle = '{}';
const safeManifest = '{}';
let runner = tplBody
  .replace('${REAL_NODE_IMPORTS}', '/* real-node-imports */')
  .replace('${safeCode}', safeCode)
  .replace('${safeBundle}', safeBundle)
  .replace('${safeManifest}', safeManifest)
  .replace('${SHIMS}', shims)
  // Unescape JS template-literal sequences
  .replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');

writeFileSync('/tmp/runner.js', runner);
const lines = runner.split('\n');
console.log('total lines:', lines.length);
const probe = [17, 34, 44, 303, 708, 2697, 2712, 2803, 2841];
for (const n of probe) console.log(`L${n}:`, JSON.stringify((lines[n-1]||'').slice(0,140)));
