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
w.send(JSON.stringify({
  type: 'input',
  data: 'git clone https://github.com/AshishKumar4/Mossaic && cd Mossaic && npm install\r',
}));
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 1000));
  if (/added \d+ packages/.test(buf)) break;
}
await new Promise(r => setTimeout(r, 8000));
const stripped = buf.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
// Print synth lines
const synth = stripped.split('\n').filter(l => /synthesized|skipped|barrel|Pre-bundle/.test(l));
for (const l of synth) console.log(l);
console.log('---DIAG---');
const diag = await fetch(BASE + '/s/' + sid + '/api/_diag/memory').then(r => r.json());
console.log(JSON.stringify(diag.counters.preBundleFacet, null, 2));
w.close();
process.exit(0);
