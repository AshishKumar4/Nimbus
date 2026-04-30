// Phase 5: dynamic-semantics probes — __dirname, __filename, import.meta.url,
// dynamic require/import, eval, top-level await.
import { runProbe, runMany } from './_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'dynamic');

const PROBES = [
  { name: 'dirname-filename',
    expr: `console.log('__dirname typeof:', typeof __dirname, JSON.stringify(__dirname));
console.log('__filename typeof:', typeof __filename, JSON.stringify(__filename));` },

  { name: 'import-meta',
    expr: `try { console.log('import.meta:', typeof import.meta, JSON.stringify(import.meta && import.meta.url)); } catch(e) { console.log('SyntaxError on import.meta:', e.message); }` },

  { name: 'dynamic-require-literal',
    expr: `const fs = require('fs'); console.log('literal require ok:', typeof fs.readFileSync);` },

  { name: 'dynamic-require-variable',
    expr: `const name = 'fs';
try { const m = require(name); console.log('variable require ok:', typeof m.readFileSync); }
catch(e) { console.log('variable require failed:', e.message); }` },

  { name: 'require-resolve',
    expr: `try { console.log('require.resolve(fs):', require.resolve('fs')); } catch(e) { console.log('resolve fs fail:', e.message); }
try { console.log('require.resolve(path):', require.resolve('path')); } catch(e) { console.log('resolve path fail:', e.message); }
try { console.log('require.resolve(./nope):', require.resolve('./nope')); } catch(e) { console.log('resolve relative fail:', e.message); }` },

  { name: 'dynamic-import-literal',
    expr: `import('fs').then(m => console.log('dyn import literal ok:', typeof m.readFileSync)).catch(e => console.log('dyn import literal fail:', e.message));
setTimeout(()=>{}, 2000);` },

  { name: 'dynamic-import-variable',
    expr: `const spec = 'fs';
import(spec).then(m => console.log('dyn import var ok:', typeof m.readFileSync)).catch(e => console.log('dyn import var fail:', e.message));
setTimeout(()=>{}, 2000);` },

  { name: 'eval-and-Function',
    expr: `try { console.log('eval(1+1):', eval('1+1')); } catch(e) { console.log('eval fail:', e.message); }
try { const f = new Function('return 42'); console.log('new Function:', f()); } catch(e) { console.log('new Function fail:', e.message); }` },

  { name: 'top-level-await',
    expr: `// TLA — should fail because user code runs inside new Function().
const x = await Promise.resolve(1); console.log('TLA result:', x);` },

  { name: 'process-cwd-chdir',
    expr: `console.log('cwd before:', process.cwd());
try { process.chdir('/tmp'); console.log('cwd after chdir:', process.cwd()); } catch(e) { console.log('chdir fail:', e.message); }` },

  { name: 'globals',
    expr: `console.log('globalThis typeof:', typeof globalThis);
console.log('Buffer typeof:', typeof Buffer);
console.log('process typeof:', typeof process);
console.log('queueMicrotask typeof:', typeof queueMicrotask);
console.log('AbortController typeof:', typeof AbortController);
console.log('fetch typeof:', typeof fetch);
console.log('crypto typeof:', typeof crypto);
console.log('crypto.subtle typeof:', typeof (typeof crypto !== 'undefined' && crypto.subtle));
console.log('WebAssembly typeof:', typeof WebAssembly);` },
];

const skipExisting = process.argv.includes('--skip-existing');

const jobs = PROBES.map(t => async () => {
  const artifactPath = path.join(OUT_DIR, `${t.name}.out.txt`);
  if (skipExisting && fs.existsSync(artifactPath) && fs.statSync(artifactPath).size > 200) {
    return { name: t.name, skipped: true };
  }
  fs.writeFileSync(artifactPath, '');
  fs.writeFileSync(path.join(OUT_DIR, `${t.name}.probe.js`), t.expr);
  console.log(`[START] ${t.name}`);
  const id = `dyn_${Date.now().toString(36)}_${t.name}`;
  const b64 = Buffer.from(t.expr, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/tmp/${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd = `node /tmp/${id}.js`;
  const r = await runProbe(t.name, [
    { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 15_000 },
  ], { artifactPath, settleMs: 2500 });
  console.log(`[DONE] ${t.name}`);
  return { name: t.name, ok: r.ok };
});

const results = await runMany(jobs, 3);
fs.writeFileSync(path.join(OUT_DIR, '_SUMMARY.json'), JSON.stringify(results, null, 2));
console.log('Done.');
