// Probe: in fresh session, install seed, then check if scanner finds names.
// Method: hit /preview/@modules/lucide-react and dump the response. The 503
// message includes which path was taken.
import WebSocket from 'ws';
const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
console.log('sid=' + sid);
const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let buf = '';
await new Promise(res => w.on('open', res));
w.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'output') buf += m.data; } catch {} });
w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
await new Promise(r => setTimeout(r, 1500));
w.send(JSON.stringify({ type: 'input', data: 'cd app && npm install && npm run dev\r' }));
let viteReady = false;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json());
    if (stats?.vite?.running) { viteReady = true; break; }
  } catch {}
}
if (!viteReady) { console.log('vite never ready'); process.exit(1); }
await new Promise(r => setTimeout(r, 4000));

// Look for synth-related shell output
const stripped = buf.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
const synthLines = stripped.split('\n').filter(l => /synthe|barrel|skipped pre-bundle/.test(l));
console.log('shell synth/barrel lines:');
for (const l of synthLines) console.log('  ' + l);

// Hit lucide-react
const r2 = await fetch(BASE + '/s/' + sid + '/preview/@modules/lucide-react');
console.log('\n/preview/@modules/lucide-react:');
console.log('  status', r2.status, 'ct', r2.headers.get('content-type'));
const body = await r2.text();
console.log('  body[0:500]:');
console.log('  ' + body.slice(0, 500).replace(/\n/g, '\n  '));

// Probe again to see if 2nd hit caches
const r3 = await fetch(BASE + '/s/' + sid + '/preview/@modules/lucide-react');
console.log('\nsecond hit: status', r3.status);

w.close();
process.exit(0);
