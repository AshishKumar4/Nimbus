// Quick capture: run `npm install` of a single tiny pkg and dump
// the time-ordered wire frames so we can see WHERE the prompt
// appears relative to the trailing [npm] / warn lines.
import { BASE, mintSession, WsSession, sleep, strip } from '../../interactive-liveness/_driver.mjs';

const sid = await mintSession();
const ws = new WsSession(sid);
await ws.connect();
await ws.waitForPrompt(20000);

// Patch the ws to record per-frame timestamps.
const frames = [];
const origOnMsg = ws.ws.listeners('message')[0];
ws.ws.removeAllListeners('message');
ws.ws.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'output' && typeof m.data === 'string') {
      frames.push({ ts: Date.now(), data: m.data });
    }
  } catch {}
  origOnMsg(data);
});

const t0 = Date.now();

// Set up a project with a tiny pkg.
ws.send('mkdir -p /home/user/app && cd /home/user/app\n');
await ws.waitForNewPrompt(5000);
// React + zod — pre-bundle path runs, peer-dep warns possible.
ws.send(`echo '{"name":"t","version":"1.0.0","dependencies":{"react":"18.3.1","react-dom":"18.3.1","zod":"3.23.8"}}' > package.json\n`);
await ws.waitForNewPrompt(5000);
ws.reset();
frames.length = 0;

// Run npm install.
ws.send('npm install\n');
// Wait long enough for it to finish AND for any trailing
// frames to arrive. We deliberately wait > the prompt-return
// boundary so we can see late frames if they exist.
await ws.waitForNewPrompt(120000);
const promptArrivedAt = Date.now();
// Grace period — see if any frames arrive AFTER the prompt.
await sleep(2000);
const totalEnd = Date.now();

ws.close();

// Order frames by ts and print them with their offset from
// promptArrivedAt to make late frames visible.
console.log('==== captured frames ====');
for (const f of frames) {
  const offset = f.ts - promptArrivedAt;
  const sign = offset >= 0 ? '+' : '';
  const stripped = strip(f.data).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const trimmed = stripped.length > 110 ? stripped.slice(0, 107) + '...' : stripped;
  console.log(`t${sign}${offset.toString().padStart(5)}ms  ${JSON.stringify(trimmed)}`);
}
console.log('==== summary ====');
console.log(`total frames: ${frames.length}`);
console.log(`prompt arrived at: t+${(promptArrivedAt - t0)}ms`);
console.log(`grace window end: t+${(totalEnd - t0)}ms`);
const lateFrames = frames.filter(f => f.ts > promptArrivedAt + 50);
console.log(`frames arriving > 50ms AFTER prompt: ${lateFrames.length}`);
for (const f of lateFrames) {
  const stripped = strip(f.data).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  console.log(`  +${f.ts - promptArrivedAt}ms: ${JSON.stringify(stripped.slice(0, 120))}`);
}
