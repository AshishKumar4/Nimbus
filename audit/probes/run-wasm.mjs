// Phase 4: WASM alternatives for native-binding packages.
// Each: install + smoke (running from /home/user/app for proper resolution).
import { runProbe, runMany } from './_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'wasm');

const TESTS = [
  { name: 'bcryptjs',
    pkg: 'bcryptjs',
    smoke: `const b=require('bcryptjs');const h=b.hashSync('pw',4);console.log('hash len:',h.length);console.log('verify:',b.compareSync('pw',h));` },

  { name: 'sass',
    pkg: 'sass',
    smoke: `const s=require('sass');const r=s.compileString('a{b:1px+2px}');console.log('css:',r.css.replace(/\\s/g,''));` },

  { name: 'grpc-grpc-js',
    pkg: '@grpc/grpc-js',
    smoke: `const g=require('@grpc/grpc-js');console.log('keys:',Object.keys(g).slice(0,8).join(','));console.log('credentials.createInsecure:',typeof g.credentials.createInsecure);` },

  { name: 'sql-js',
    pkg: 'sql.js',
    smoke: `const initSqlJs=require('sql.js');initSqlJs().then(SQL=>{const db=new SQL.Database();db.run('CREATE TABLE t(x)');db.run('INSERT INTO t VALUES (?)',[42]);const r=db.exec('SELECT * FROM t');console.log('result:',JSON.stringify(r));}).catch(e=>console.log('ERR:',e.message));setTimeout(()=>{},6000);` },

  { name: 'libsql-client',
    pkg: '@libsql/client',
    smoke: `const m=require('@libsql/client');console.log('keys:',Object.keys(m).slice(0,8).join(','));console.log('createClient typeof:',typeof m.createClient);` },

  { name: 'esbuild-wasm',
    pkg: 'esbuild-wasm',
    smoke: `const e=require('esbuild-wasm');console.log('keys:',Object.keys(e).slice(0,10).join(','));console.log('transformSync typeof:',typeof e.transformSync);` },

  { name: 'swc-wasm-web',
    pkg: '@swc/wasm-web',
    smoke: `try { const m=require('@swc/wasm-web');console.log('keys:',Object.keys(m).slice(0,10).join(',')); } catch(e) { console.log('LOAD FAIL:', e.message); }` },

  { name: 'tailwindcss-oxide-wasm',
    pkg: '@tailwindcss/oxide-wasm32-wasi',
    smoke: `try { const m=require('@tailwindcss/oxide-wasm32-wasi'); console.log('keys:',Object.keys(m).slice(0,10).join(',')); } catch(e) { console.log('LOAD FAIL:', e.message); console.log('STACK:', e.stack && e.stack.split('\\n').slice(0,4).join(' | ')); }` },

  { name: 'resvg-wasm',
    pkg: '@resvg/resvg-wasm',
    smoke: `try { const m=require('@resvg/resvg-wasm'); console.log('keys:',Object.keys(m).slice(0,10).join(',')); } catch(e) { console.log('LOAD FAIL:', e.message); }` },

  { name: 'wasm-vips',
    pkg: 'wasm-vips',
    smoke: `try { const m=require('wasm-vips'); console.log('keys:',Object.keys(m).slice(0,10).join(',')); } catch(e) { console.log('LOAD FAIL:', e.message); }` },

  { name: 'rollup-wasm-node',
    pkg: '@rollup/wasm-node',
    smoke: `try { const m=require('@rollup/wasm-node');console.log('keys:',Object.keys(m).slice(0,10).join(','));console.log('rollup typeof:',typeof m.rollup); } catch(e) { console.log('LOAD FAIL:', e.message); }` },

  { name: 'hash-wasm',
    pkg: 'hash-wasm',
    smoke: `const m=require('hash-wasm');console.log('keys:',Object.keys(m).slice(0,10).join(','));m.sha256('hello').then(h=>console.log('sha256(hello):',h)).catch(e=>console.log('hash err:',e.message));setTimeout(()=>{},3000);` },
];

const skipExisting = process.argv.includes('--skip-existing');

const jobs = TESTS.map(t => async () => {
  const artifactPath = path.join(OUT_DIR, `${t.name}.out.txt`);
  if (skipExisting && fs.existsSync(artifactPath) && fs.statSync(artifactPath).size > 200) {
    console.log(`[SKIP] ${t.name}`);
    return { name: t.name, skipped: true };
  }
  fs.writeFileSync(artifactPath, '');
  fs.writeFileSync(path.join(OUT_DIR, `${t.name}.probe.js`), t.smoke);
  console.log(`[START] ${t.name}`);
  const id = `wasmsmoke_${Date.now().toString(36)}_${t.name}`;
  const b64 = Buffer.from(t.smoke, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd = `cd /home/user/app && node .${id}.js`;
  const r = await runProbe(t.name, [
    { kind: 'cmd', cmd: `cd app && npm install ${t.pkg}`, timeoutMs: 240_000 },
    { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 60_000 },
  ], { artifactPath, settleMs: 3000 });
  console.log(`[DONE] ${t.name} ok=${r.ok}`);
  return { name: t.name, ok: r.ok };
});

console.log(`Running ${jobs.length} WASM probes (concurrency=2)...`);
const results = await runMany(jobs, 2);
fs.writeFileSync(path.join(OUT_DIR, '_SUMMARY.json'), JSON.stringify(results, null, 2));
console.log('Done.');
