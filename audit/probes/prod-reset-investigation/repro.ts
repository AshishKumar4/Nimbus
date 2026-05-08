// Bun WS client to repro user flow against prod.
// Usage: bun run audit/probes/prod-reset-investigation/repro.ts <sessionId>
//
// Drives: cd app && npm i && npm run dev
// Captures: all output + timestamps; logs to stdout.
//
// The MAIN signal is whether the welcome banner appears more than once
// during the session (= shell re-init = DO restart OR spurious
// initSession call). PWD prompt drift to /home/user is also captured.

const sessionId = process.argv[2];
if (!sessionId) { console.error('usage: bun repro.ts <sessionId>'); process.exit(2); }

const url = `wss://nimbus.ashishkmr472.workers.dev/s/${sessionId}/ws`;
console.error(`[repro] connecting ${url}`);

const ws = new WebSocket(url);
let connected = false;
let outputBuf = '';
let bannerCount = 0;
let lastBannerAt = 0;
const bannerMarker = 'Cloud Dev Environment';
const startMs = Date.now();

const log = (...a: any[]) => {
  const t = ((Date.now() - startMs) / 1000).toFixed(2);
  console.error(`[t=${t}s]`, ...a);
};

ws.onopen = () => {
  connected = true;
  log('WS open');
};

ws.onmessage = (ev: MessageEvent) => {
  try {
    const m = JSON.parse(ev.data as string);
    if (m.type === 'output' && typeof m.data === 'string') {
      process.stdout.write(m.data);
      outputBuf += m.data;
      // Detect banner re-print
      if (m.data.includes(bannerMarker)) {
        bannerCount++;
        const now = Date.now();
        log(`*** BANNER #${bannerCount} (Δ=${now - lastBannerAt}ms since prev) ***`);
        lastBannerAt = now;
      }
    }
  } catch (e: any) {
    log('msg parse err:', e.message, 'raw=', ev.data);
  }
};

ws.onerror = (e: any) => { log('WS error:', e?.message ?? e); };
ws.onclose = (e: CloseEvent) => { log('WS closed', e.code, e.reason); };

const send = (data: string) => {
  if (ws.readyState !== 1) { log('!! WS not open, drop send', JSON.stringify(data)); return; }
  ws.send(JSON.stringify({ type: 'input', data }));
};

const waitFor = (predicate: (buf: string) => boolean, timeoutMs: number, label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (predicate(outputBuf)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
      }
    }, 250);
  });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  // Wait for connect + initial prompt
  const waitOpen = async () => {
    while (!connected && Date.now() - startMs < 15000) await sleep(100);
    if (!connected) throw new Error('WS never opened');
  };
  await waitOpen();
  log('waiting for first prompt...');
  await waitFor((b) => b.includes('$') || b.includes('#') || b.includes('>'), 10000, 'first prompt');
  log('first prompt seen, pwd at:', JSON.stringify(outputBuf.slice(-100)));
  await sleep(500);

  // Stage 1: cd app
  log('=== stage 1: cd app ===');
  outputBuf = '';
  send('cd app\r');
  await sleep(800);

  // Stage 2: npm i  (long)
  log('=== stage 2: npm i ===');
  outputBuf = '';
  send('npm i\r');
  // wait up to 90s for completion: prompt return after 'added X packages' or similar
  try {
    await waitFor((b) => /added \d+ packages|up to date/.test(b), 120000, 'npm i complete');
    log('npm i appears complete');
  } catch (e: any) {
    log('npm i timeout or failure:', e.message);
  }
  await sleep(1500);

  // Stage 3: npm run dev
  log('=== stage 3: npm run dev ===');
  outputBuf = '';
  send('npm run dev\r');
  // wait for vite ready or pre-bundle complete log
  try {
    await waitFor(
      (b) => /Local:.*localhost|ready in \d+ms|Pre-bundle complete/i.test(b),
      120000,
      'vite ready'
    );
    log('vite ready signal seen');
  } catch (e: any) {
    log('vite ready timeout:', e.message);
  }

  // Stage 4: hold the connection open 60s to observe DO behaviour under
  // an active vite dev server (HMR + watcher).
  log('=== stage 4: idle hold 60s with active dev server ===');
  await sleep(60000);

  log(`done. total banners=${bannerCount}`);
  ws.close();
  await sleep(300);
  process.exit(0);
})().catch(e => { log('FATAL:', e?.stack ?? e); ws.close(); process.exit(1); });
