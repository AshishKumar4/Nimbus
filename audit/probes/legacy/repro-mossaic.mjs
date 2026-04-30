
import WebSocket from 'ws';

const r = await fetch('https://nimbus.ashishkmr472.workers.dev/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)?.[1];
console.log('SID=' + sid);

const w = new WebSocket('wss://nimbus.ashishkmr472.workers.dev/s/' + sid + '/ws');
let o = '';
w.on('open', () => w.send(JSON.stringify({type:'resize',cols:200,rows:60})));
w.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'output') o += m.data; });
w.on('close', () => console.log('!!! WS CLOSED'));
const cmd = (c) => w.send(JSON.stringify({type:'input',data:c+'\r'}));
const strip = s => s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
const probe = async () => { try { return JSON.parse(await (await fetch('https://nimbus.ashishkmr472.workers.dev/s/' + sid + '/api/_diag/memory')).text()); } catch (e) { return { err: String(e).slice(0,80) }; } };

await new Promise(r => setTimeout(r, 4000));

cmd('git clone https://github.com/AshishKumar4/Mossaic');
let cloned = false;
for (let i = 0; i < 30 && !cloned; i++) {
  await new Promise(r => setTimeout(r, 3000));
  if (/clone complete|files,/.test(strip(o).slice(-300))) { cloned = true; break; }
}
console.log('cloned=' + cloned);

cmd('cd Mossaic && npm i');
let installDone = false;
const installStart = Date.now();
const baselineLen = strip(o).length;

for (let i = 0; i < 60 && !installDone; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const tail = strip(o).slice(-300);
  if (/added \d+ packages/.test(strip(o).slice(-500))) { installDone = true; break; }
  if (i % 5 === 0) console.log('[' + Math.floor((Date.now()-installStart)/1000) + 's] ' + tail.replace(/\n/g, ' | ').slice(-180));
}
console.log('install=' + installDone + ' (' + Math.floor((Date.now()-installStart)/1000) + 's)');

// CRITICAL: monitor for DO restart banners during pre-bundle phase
console.log('=== monitoring for crashes (60s) ===');
let bannerCount = 0;
let lastDiag = null;

for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const after = strip(o).slice(baselineLen);
  bannerCount = (after.match(/Cloud Dev Environment/g) || []).length;
  const diag = await probe();
  console.log('[' + (i*3) + 's] banners=' + bannerCount + ' files=' + (diag.vfs?.files || '?') + ' preBundle=' + JSON.stringify(diag.counters?.preBundleFacet || {}).slice(0, 200));
  if (bannerCount > 0) {
    console.log('!!! DO RESTART DETECTED');
    console.log('TERMINAL TAIL (1500):', strip(o).slice(-1500));
    break;
  }
  lastDiag = diag;
}

console.log('=== FINAL ===');
console.log('banners=' + bannerCount + ' (target: 0)');
console.log('SID=' + sid);
w.close();
process.exit(bannerCount > 0 ? 1 : 0);
