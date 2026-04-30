// Reusable Nimbus prod WS driver. Persisted under /workspace/lifo-edge-os/audit/.
//
// runProbe(label, steps, opts) opens fresh prod session, runs steps, writes
// raw output to opts.artifactPath. Each call gets a new SID.
//
// nodeEvalBase64(jsSource) avoids two layers of pain:
//   - shell-quoting multi-line JS through WS input
//   - workerd's `disallow_eval_during_request_handler` (request-time eval()
//     and new Function() throw EvalError; verified probe e93b18d-002).
// Strategy: write the JS source to /tmp/p_<id>.js via a pure-fs `node -e`
// (which is just file I/O, no eval), then `node /tmp/p_<id>.js`.

import WebSocket from 'ws';
import fs from 'fs';

const BASE = 'https://nimbus.ashishkmr472.workers.dev';

function strip(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
}

let _scriptCounter = 0;
export function nodeEvalBase64(jsSource) {
  const id = ++_scriptCounter + '_' + Date.now().toString(36);
  const b64 = Buffer.from(jsSource, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('/tmp/p_${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && node /tmp/p_${id}.js`;
}

export function nodeEval(jsSource) {
  // Single-line only.
  const escaped = jsSource.replace(/'/g, `'"'"'`);
  return `node -e '${escaped}'`;
}

export async function runProbe(label, steps, opts = {}) {
  const { artifactPath, settleMs = 4000 } = opts;
  const log = (s) => { if (artifactPath) fs.appendFileSync(artifactPath, s); };

  log(`==== PROBE: ${label} ====\n`);
  log(`==== TIMESTAMP: ${new Date().toISOString()} ====\n`);

  let sid;
  try {
    const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    const m = loc.match(/\/s\/([^\/]+)/);
    if (!m) throw new Error('no session in redirect: ' + loc);
    sid = m[1];
    log(`==== SID: ${sid} ====\n`);
  } catch (e) {
    log(`==== POST /new FAILED: ${e.message} ====\n`);
    return { ok: false, sid: null };
  }

  const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
  let buffer = '';
  let wsClosed = false;

  await new Promise((res, rej) => {
    w.on('open', () => res());
    w.on('error', (e) => rej(e));
    w.on('close', () => { wsClosed = true; });
    setTimeout(() => rej(new Error('ws open timeout')), 15_000);
  }).catch((e) => { log(`==== WS OPEN FAILED: ${e.message} ====\n`); });

  if (wsClosed) return { ok: false, sid };

  w.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'output') buffer += m.data;
    } catch {}
  });

  w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
  await new Promise((r) => setTimeout(r, settleMs));
  log(`---- initial banner ----\n${strip(buffer).slice(-400)}\n---- end banner ----\n`);
  buffer = '';

  for (const step of steps) {
    if (step.kind === 'cmd') {
      log(`\n---- STEP cmd: ${step.cmd.slice(0, 800)}${step.cmd.length > 800 ? '...[truncated]' : ''} ----\n`);
      buffer = '';
      w.send(JSON.stringify({ type: 'input', data: step.cmd + '\r' }));
      const t0 = Date.now();
      const timeout = step.timeoutMs || 30_000;
      const waitFor = step.waitFor;
      while (Date.now() - t0 < timeout) {
        if (wsClosed) break;
        if (waitFor && waitFor.test(strip(buffer))) break;
        if (!waitFor && /[\$#]\s*$/.test(strip(buffer.slice(-100)))) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const elapsed = Date.now() - t0;
      log(strip(buffer));
      log(`\n---- step done in ${elapsed}ms (wsClosed=${wsClosed}) ----\n`);
      if (wsClosed) break;
    } else if (step.kind === 'sleep') {
      await new Promise((r) => setTimeout(r, step.ms));
    }
  }

  try { w.close(); } catch {}
  log(`\n==== END PROBE: ${label} ====\n`);
  return { ok: true, sid };
}

export async function runMany(jobs, concurrency = 3) {
  let cursor = 0;
  const results = [];
  async function worker() {
    while (cursor < jobs.length) {
      const idx = cursor++;
      try { results[idx] = await jobs[idx](); }
      catch (e) { results[idx] = { ok: false, error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
