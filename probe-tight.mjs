import WebSocket from 'ws';
const BASE = 'https://nimbus.ashishkmr472.workers.dev';

const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
console.log('sid=' + sid);

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let o = '';
let wsClosed = false;
w.on('open', () => w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 })));
w.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'output') o += m.data; });
w.on('close', () => { wsClosed = true; });

const cmd = (c) => w.send(JSON.stringify({ type: 'input', data: c + '\r' }));
const probe = async () => {
  try {
    const r = await fetch(BASE + '/s/' + sid + '/api/_diag/memory');
    return await r.json();
  } catch (e) { return null; }
};

await new Promise((r) => setTimeout(r, 4000));
cmd('cd app && npm install');

let bestSnapshot = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const m = await probe();
  if (!m) continue;
  const c = m.counters || {};
  const inst = c.installFacet || {};
  // Save the snapshot with the highest tarballsCompleted before crash.
  if (inst.tarballsCompleted >= (bestSnapshot?.installFacet?.tarballsCompleted ?? 0)) {
    bestSnapshot = c;
  }
  console.log(`[${i}s] phase=${c.installPhase} resolver=${c.resolverPath}(${(c.cumulativePackumentBytesDecoded/1048576||0).toFixed(2)}MiB) install=${inst.path}(${inst.tarballsCompleted}t/${(inst.cumulativeBytesDecoded/1048576||0).toFixed(2)}MiB pk=${inst.peakInFlight}) files=${m.vfs?.files} ws=${wsClosed?'X':'.'}`);
  if (wsClosed) break;
}
console.log('\nbest pre-crash snapshot:');
console.log(JSON.stringify(bestSnapshot, null, 2));
console.log('\nfinal terminal:');
console.log(o.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g,'').slice(-1500));
try { w.close(); } catch {}
process.exit(0);
