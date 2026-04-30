// Phase 1 probes: node:* builtins matrix.
//
// For each builtin we run a minimal facet smoke test that:
//   1) require()s the module and dumps its keys
//   2) exercises a representative API to detect shim fakery
// Output captured to audit/probes/node-builtins/<name>.out.txt.
// The .mjs source is committed alongside; the captured .out.txt is the
// evidence cited by audit/sections/01-node-builtins.md.

import { runProbe, nodeEvalBase64, runMany } from './_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'node-builtins');

const PROBES = [
  // fs — VFS-backed shim
  { name: 'fs', expr: `const fs = require('fs');
console.log('keys:', Object.keys(fs).slice(0, 25).join(','));
console.log('readFileSync:', typeof fs.readFileSync);
console.log('promises:', typeof fs.promises);
try { fs.writeFileSync('/tmp/_probe', 'hi'); console.log('write+read:', fs.readFileSync('/tmp/_probe', 'utf8')); } catch(e) { console.log('write fail:', e.message); }
console.log('createReadStream:', typeof fs.createReadStream);
console.log('openSync typeof:', typeof fs.openSync);
console.log('realpathSync typeof:', typeof fs.realpathSync);
` },

  { name: 'fs-promises', expr: `const fsp = require('fs/promises');
console.log('keys:', Object.keys(fsp).slice(0, 20).join(','));
fsp.writeFile('/tmp/_p', 'x').then(()=>fsp.readFile('/tmp/_p','utf8')).then(v=>console.log('roundtrip:',v)).catch(e=>console.log('err:',e.message));
console.log('cp typeof:', typeof fsp.cp);
console.log('rm typeof:', typeof fsp.rm);
console.log('open typeof:', typeof fsp.open);
` },

  // crypto — THE BUG TARGET
  { name: 'crypto', expr: `const c = require('crypto');
console.log('keys:', Object.keys(c).slice(0, 25).join(','));
console.log('randomBytes:', c.randomBytes(4).toString('hex'));
console.log('randomUUID:', c.randomUUID && c.randomUUID());
const h = c.createHash('sha256');
h.update('hello');
console.log('sha256(hello):', h.digest('hex'));
console.log('expected real:    2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
const h2 = c.createHash('md5');
h2.update('hello');
console.log('md5(hello):', h2.digest('hex'));
console.log('expected real: 5d41402abc4b2a76b9719d911017c592');
try { console.log('hmac:', c.createHmac('sha256', 'k').update('m').digest('hex')); } catch(e) { console.log('hmac fail:', e.message); }
console.log('createCipheriv:', typeof c.createCipheriv);
console.log('scrypt:', typeof c.scrypt);
console.log('pbkdf2:', typeof c.pbkdf2);
console.log('generateKeyPair:', typeof c.generateKeyPair);
` },

  { name: 'util', expr: `const u = require('util');
console.log('keys:', Object.keys(u).slice(0, 20).join(','));
console.log('inspect basic:', u.inspect({a:1, b:[1,2]}));
const cyc = {}; cyc.self = cyc;
try { console.log('inspect cyclic:', u.inspect(cyc)); } catch(e) { console.log('inspect cyclic THREW:', e.message); }
console.log('format:', u.format('%s=%d', 'x', 42));
console.log('promisify typeof:', typeof u.promisify);
console.log('parseArgs typeof:', typeof u.parseArgs);
console.log('debuglog typeof:', typeof u.debuglog);
` },

  { name: 'path', expr: `const p = require('path');
console.log('keys:', Object.keys(p).slice(0, 15).join(','));
console.log('join:', p.join('/a','b/../c','d.txt'));
console.log('resolve:', p.resolve('/a','./b','c'));
console.log('basename:', p.basename('/a/b/c.txt','.txt'));
console.log('dirname:', p.dirname('/a/b/c.txt'));
console.log('extname:', p.extname('foo.tar.gz'));
console.log('posix===path:', p.posix === p);
console.log('win32 typeof:', typeof p.win32);
` },

  { name: 'stream', expr: `const s = require('stream');
console.log('keys:', Object.keys(s).slice(0, 15).join(','));
console.log('Readable:', typeof s.Readable);
console.log('Writable:', typeof s.Writable);
console.log('Transform:', typeof s.Transform);
console.log('promises typeof:', typeof s.promises);
console.log('web typeof:', typeof s.web);
const r = s.Readable.from(['a','b','c']);
let out=''; r.on('data', c=>out+=c); r.on('end', ()=>console.log('Readable.from collected:', out));
` },

  { name: 'buffer', expr: `const B = require('buffer');
console.log('keys:', Object.keys(B).slice(0, 10).join(','));
const b = Buffer.from('hello');
console.log('from:', b.toString('hex'));
console.log('isBuffer:', Buffer.isBuffer(b));
console.log('alloc:', Buffer.alloc(3, 0).toString('hex'));
console.log('concat:', Buffer.concat([b, Buffer.from(' world')]).toString());
console.log('byteLength:', Buffer.byteLength('héllo', 'utf8'));
console.log('Blob:', typeof B.Blob);
console.log('File:', typeof B.File);
` },

  { name: 'events', expr: `const E = require('events');
const ee = new E();
ee.on('x', v=>console.log('got:',v));
ee.emit('x', 42);
console.log('once typeof:', typeof E.once);
console.log('listenerCount:', ee.listenerCount('x'));
console.log('getEventListeners:', typeof E.getEventListeners);
` },

  { name: 'os', expr: `const o = require('os');
console.log('keys:', Object.keys(o).slice(0, 20).join(','));
console.log('platform:', o.platform());
console.log('arch:', o.arch());
console.log('tmpdir:', o.tmpdir());
console.log('homedir:', o.homedir());
console.log('hostname:', o.hostname());
console.log('cpus length:', o.cpus().length);
console.log('totalmem:', o.totalmem());
console.log('availableParallelism typeof:', typeof o.availableParallelism);
` },

  { name: 'url', expr: `const U = require('url');
console.log('keys:', Object.keys(U).slice(0, 12).join(','));
console.log('URL.pathname:', new U.URL('http://a.com/p?x=1').pathname);
console.log('parse:', U.parse('http://a.com/p?x=1').query);
console.log('fileURLToPath:', U.fileURLToPath('file:///a/b'));
console.log('pathToFileURL:', String(U.pathToFileURL('/x/y')));
` },

  { name: 'querystring', expr: `const q = require('querystring');
console.log('keys:', Object.keys(q).slice(0, 10).join(','));
console.log('parse default:', JSON.stringify(q.parse('a=1&b=2')));
console.log('parse custom-sep:', JSON.stringify(q.parse('a=1;b=2', ';')));
console.log('stringify:', q.stringify({a:1,b:'x y'}));
` },

  { name: 'zlib', expr: `const z = require('zlib');
console.log('keys:', Object.keys(z).slice(0, 18).join(','));
try { console.log('gzipSync:', z.gzipSync(Buffer.from('hi')).toString('hex')); } catch(e) { console.log('gzipSync THREW:', e.message); }
try { console.log('deflateSync:', z.deflateSync(Buffer.from('hi')).toString('hex')); } catch(e) { console.log('deflateSync THREW:', e.message); }
z.gzip(Buffer.from('hello'), (err, out) => console.log('async gzip:', err?err.message:('ok len='+out.length)));
console.log('brotliCompressSync typeof:', typeof z.brotliCompressSync);
` },

  { name: 'http', expr: `const h = require('http');
console.log('keys:', Object.keys(h).slice(0, 15).join(','));
console.log('createServer:', typeof h.createServer);
try { const s = h.createServer((req,res)=>res.end('ok')); console.log('Server constructed:', !!s); } catch(e) { console.log('createServer threw:', e.message); }
try { h.request('http://example.com', r=>{}); console.log('request OK'); } catch(e) { console.log('request threw:', e.message); }
try { h.get('http://example.com', r=>{}); console.log('get OK'); } catch(e) { console.log('get threw:', e.message); }
` },

  { name: 'https', expr: `const h = require('https');
console.log('keys:', Object.keys(h).slice(0, 15).join(','));
console.log('request typeof:', typeof h.request);
console.log('get typeof:', typeof h.get);
` },

  { name: 'net', expr: `const n = require('net');
console.log('keys:', Object.keys(n).slice(0, 15).join(','));
console.log('isIP v4:', n.isIP('1.2.3.4'));
console.log('isIP v6:', n.isIP('::1'));
const sock = new n.Socket();
sock.on('connect', () => console.log('Socket connect emitted'));
sock.on('error', (e) => console.log('Socket error:', e.message));
sock.connect(443, 'example.com');
setTimeout(() => console.log('Socket state: connecting=', sock.connecting, 'remoteAddress=', sock.remoteAddress), 1500);
` },

  { name: 'tls', expr: `try { const t = require('tls'); console.log('keys:', Object.keys(t).slice(0, 15).join(',')); console.log('connect typeof:', typeof t.connect); console.log('createServer typeof:', typeof t.createServer); } catch(e) { console.log('tls require failed:', e.message); }
` },

  { name: 'child_process', expr: `const cp = require('child_process');
console.log('keys:', Object.keys(cp).slice(0, 15).join(','));
try { cp.execSync('echo hi'); console.log('execSync ok'); } catch(e) { console.log('execSync THREW:', e.message); }
cp.exec('echo hi', (err, stdout) => console.log('exec err:', err && err.message, 'stdout:', JSON.stringify(stdout)));
const child = cp.spawn('echo', ['hi']);
child.on('error', e => console.log('spawn error:', e.message));
child.on('exit', c => console.log('spawn exit:', c));
setTimeout(()=>{}, 1000);
` },

  { name: 'vm', expr: `try { const v = require('vm'); console.log('keys:', Object.keys(v).slice(0, 10).join(',')); console.log('runInNewContext typeof:', typeof v.runInNewContext); try { console.log('runInNewContext result:', v.runInNewContext('1+2')); } catch(e) { console.log('runInNewContext THREW:', e.message); } } catch(e) { console.log('vm require failed:', e.message); }
` },

  { name: 'worker_threads', expr: `try { const w = require('worker_threads'); console.log('keys:', Object.keys(w).slice(0, 15).join(',')); console.log('isMainThread:', w.isMainThread); console.log('Worker typeof:', typeof w.Worker); try { new w.Worker('console.log(1)', {eval:true}); console.log('Worker ctor ok'); } catch(e) { console.log('Worker ctor THREW:', e.message); } } catch(e) { console.log('worker_threads require failed:', e.message); }
` },

  { name: 'async_hooks', expr: `try { const a = require('async_hooks'); console.log('keys:', Object.keys(a).slice(0, 10).join(',')); console.log('AsyncLocalStorage typeof:', typeof a.AsyncLocalStorage); const als = new a.AsyncLocalStorage(); als.run({x:1}, () => console.log('ALS getStore:', JSON.stringify(als.getStore()))); } catch(e) { console.log('async_hooks fail:', e.message); }
` },

  { name: 'timers', expr: `const t = require('timers');
console.log('keys:', Object.keys(t).slice(0, 10).join(','));
console.log('setTimeout typeof:', typeof t.setTimeout);
console.log('setImmediate typeof:', typeof t.setImmediate);
console.log('promises typeof:', typeof t.promises);
` },

  { name: 'assert', expr: `const a = require('assert');
console.log('keys:', Object.keys(a).slice(0, 15).join(','));
try { a.equal(1,1); console.log('equal ok'); } catch(e){}
try { a.deepEqual({a:1},{a:1}); console.log('deepEqual flat ok'); } catch(e) { console.log('deepEqual flat fail:', e.message); }
try { a.deepEqual({a:[1,2,{b:3}]},{a:[1,2,{b:3}]}); console.log('deepEqual nested ok'); } catch(e) { console.log('deepEqual nested fail:', e.message); }
const cyc = {}; cyc.self = cyc;
try { a.deepEqual(cyc, cyc); console.log('deepEqual cyclic ok'); } catch(e) { console.log('deepEqual cyclic THREW:', e.message); }
console.log('assert.match typeof:', typeof a.match);
console.log('assert.rejects typeof:', typeof a.rejects);
` },

  { name: 'perf_hooks', expr: `const p = require('perf_hooks');
console.log('keys:', Object.keys(p).slice(0, 10).join(','));
console.log('performance.now:', typeof p.performance && typeof p.performance.now);
console.log('PerformanceObserver typeof:', typeof p.PerformanceObserver);
` },

  { name: 'process', expr: `console.log('argv:', process.argv.slice(0, 3));
console.log('platform:', process.platform);
console.log('arch:', process.arch);
console.log('version:', process.version);
console.log('cwd:', process.cwd());
console.log('env keys count:', Object.keys(process.env).length);
console.log('pid:', process.pid);
console.log('memoryUsage:', JSON.stringify(process.memoryUsage()));
console.log('hrtime typeof:', typeof process.hrtime);
console.log('hrtime.bigint typeof:', typeof process.hrtime?.bigint);
console.log('nextTick typeof:', typeof process.nextTick);
` },
];

const skipExisting = process.argv.includes('--skip-existing');
const onlyName = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];

const targets = onlyName ? PROBES.filter(p => p.name === onlyName) : PROBES;

const jobs = targets.map(t => async () => {
  const artifactPath = path.join(OUT_DIR, `${t.name}.out.txt`);
  if (skipExisting && fs.existsSync(artifactPath) && fs.statSync(artifactPath).size > 200) {
    console.log(`[SKIP] ${t.name}`);
    return { name: t.name, skipped: true };
  }
  fs.writeFileSync(artifactPath, '');
  // Also write the probe's source JS alongside for reproducibility.
  fs.writeFileSync(path.join(OUT_DIR, `${t.name}.probe.js`), t.expr);
  console.log(`[START] ${t.name}`);
  const r = await runProbe(t.name, [
    { kind: 'cmd', cmd: nodeEvalBase64(t.expr), timeoutMs: 25_000 },
  ], { artifactPath, settleMs: 2500 });
  console.log(`[DONE] ${t.name} ok=${r.ok}`);
  return { name: t.name, ok: r.ok };
});

console.log(`Running ${jobs.length} builtin probes (concurrency=4)...`);
const results = await runMany(jobs, 4);
fs.writeFileSync(path.join(OUT_DIR, '_SUMMARY.json'), JSON.stringify(results, null, 2));
console.log('Done.');
