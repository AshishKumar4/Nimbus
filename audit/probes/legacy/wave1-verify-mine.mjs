
import WebSocket from 'ws';
const r = await fetch('https://nimbus.ashishkmr472.workers.dev/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)?.[1];
console.log('SID=' + sid);
const w = new WebSocket('wss://nimbus.ashishkmr472.workers.dev/s/' + sid + '/ws');
let o = '';
w.on('open', () => w.send(JSON.stringify({type:'resize',cols:200,rows:60})));
w.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'output') o += m.data; });
const cmd = (c) => w.send(JSON.stringify({type:'input',data:c+'\r'}));
const strip = s => s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
await new Promise(r => setTimeout(r, 4000));
cmd('cd app && npm i && npm run dev');
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  await new Promise(r => setTimeout(r, 3000));
  if (/Run vite stop|VITE.*ready|Local:/.test(strip(o).slice(-1500))) { ready = true; break; }
}
console.log('vite=' + ready + ' SID=' + sid);
await new Promise(r => setTimeout(r, 600000)); // hold open for puppeteer
